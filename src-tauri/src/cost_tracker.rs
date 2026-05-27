//! コスト追跡と予算ハードキャップ。
//!
//! BYOK（ユーザーが自分の OpenAI キーを使う方式）では、高額課金を負うのは
//! ユーザー自身になる。音声リアルタイム API は高価（GPT-Realtime-2 は
//! 1 分あたり概ね $0.1〜0.5）なので、知らぬ間に月数万円という事故を防ぐため、
//! usage（トークン数）から料金を換算し、月次累計が上限に達したら
//! セッション開始をブロックする（fail-closed）。
//!
//! 制限の ON/OFF と金額の判断はユーザーに委ねる（`BudgetConfig::enabled`）。
//! OpenAI ダッシュボード側の上限とは独立した、アプリ内で完結する安全網。
//!
//! 純粋計算 + serde のみに依存し、音声デバイスや WebSocket を持たないため
//! 単体テストで全分岐を検証できる。
//
// --- 課金安全 hook bypass note（本モジュールが該当しない根拠） ---
// idempotency_key N/A / FOR UPDATE N/A / transaction N/A:
//   本モジュールは料金の"計算"のみで、Stripe 等の決済・DB 書き込み・残高更新を行わない。
// 正数検証 N/A:
//   トークン数は全て u64 で負値を型レベルで排除。料金は (非負トークン × 正の単価) なので
//   月次累計も常に非負。ユーザー入力である monthly_limit_usd の負値検証だけは
//   設定 UI 層（settings）の責務とし、本計算層では扱わない。

use serde::{Deserialize, Serialize};

/// GPT-Realtime-2 の料金単価（USD / 100 万トークン）。
///
/// 出典: OpenAI pricing 2026-05。単価が変わったらここだけ直す。
pub mod pricing {
    pub const AUDIO_INPUT_PER_M: f64 = 32.0;
    pub const AUDIO_OUTPUT_PER_M: f64 = 64.0;
    pub const TEXT_INPUT_PER_M: f64 = 4.0;
    pub const TEXT_OUTPUT_PER_M: f64 = 24.0;
    /// キャッシュ済み入力は大幅割引（繰り返し送られる system prompt 等）。
    pub const CACHED_INPUT_PER_M: f64 = 0.40;
}

/// 1 レスポンス分のトークン使用量。Realtime API の `usage` イベント由来。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Usage {
    pub audio_input_tokens: u64,
    pub audio_output_tokens: u64,
    pub text_input_tokens: u64,
    pub text_output_tokens: u64,
    pub cached_input_tokens: u64,
}

impl Usage {
    /// この usage 分の料金（USD）。
    pub fn cost_usd(&self) -> f64 {
        use pricing::*;
        let per_m = |tokens: u64, rate: f64| (tokens as f64) * rate / 1_000_000.0;
        per_m(self.audio_input_tokens, AUDIO_INPUT_PER_M)
            + per_m(self.audio_output_tokens, AUDIO_OUTPUT_PER_M)
            + per_m(self.text_input_tokens, TEXT_INPUT_PER_M)
            + per_m(self.text_output_tokens, TEXT_OUTPUT_PER_M)
            + per_m(self.cached_input_tokens, CACHED_INPUT_PER_M)
    }
}

/// 予算設定。`enabled = false` なら無制限（ユーザーが明示設定するまで縛らない）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct BudgetConfig {
    pub enabled: bool,
    pub monthly_limit_usd: f64,
}

impl Default for BudgetConfig {
    fn default() -> Self {
        // 既定は OFF。ユーザーが上限額を入れて初めて制限が効く。
        Self {
            enabled: false,
            monthly_limit_usd: 0.0,
        }
    }
}

/// 月次のコスト累計 + 予算判定。
///
/// `current_month` は `YYYYMM`（例: 2026 年 5 月 = `202605`）。
/// `add_usage` に渡した月が変わると累計を自動リセットする（課金サイクル境界）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostTracker {
    pub config: BudgetConfig,
    pub current_month: u32,
    pub month_total_usd: f64,
}

impl CostTracker {
    pub fn new(config: BudgetConfig, current_month: u32) -> Self {
        Self {
            config,
            current_month,
            month_total_usd: 0.0,
        }
    }

    /// usage を月次累計に加算し、加算後の累計（USD）を返す。
    /// `month` が現在の月と違えば、累計をリセットしてから加算する。
    pub fn add_usage(&mut self, usage: &Usage, month: u32) -> f64 {
        if month != self.current_month {
            self.current_month = month;
            self.month_total_usd = 0.0;
        }
        self.month_total_usd += usage.cost_usd();
        self.month_total_usd
    }

    /// 予算超過か。`enabled = false` なら常に false（無制限）。
    /// 上限ちょうどに達した時点で「超過」とみなす（fail-closed 寄り）。
    pub fn is_over_budget(&self) -> bool {
        self.config.enabled && self.month_total_usd >= self.config.monthly_limit_usd
    }

    /// 新しいセッションを開始してよいか。予算超過なら false（fail-closed）。
    pub fn can_start_session(&self) -> bool {
        !self.is_over_budget()
    }

    /// 上限までの残額（USD、負にはならない）。`enabled = false` なら None（無制限）。
    pub fn remaining_usd(&self) -> Option<f64> {
        if !self.config.enabled {
            return None;
        }
        Some((self.config.monthly_limit_usd - self.month_total_usd).max(0.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 浮動小数点の近似比較。
    fn approx(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "expected {b}, got {a}");
    }

    #[test]
    fn cost_single_meter() {
        // 音声入力 100 万トークン = ちょうど $32。
        let u = Usage {
            audio_input_tokens: 1_000_000,
            ..Default::default()
        };
        approx(u.cost_usd(), 32.0);
    }

    #[test]
    fn cost_all_meters_combined() {
        let u = Usage {
            audio_input_tokens: 1_000_000,  // $32
            audio_output_tokens: 1_000_000, // $64
            text_input_tokens: 1_000_000,   // $4
            text_output_tokens: 1_000_000,  // $24
            cached_input_tokens: 1_000_000, // $0.40
        };
        approx(u.cost_usd(), 32.0 + 64.0 + 4.0 + 24.0 + 0.40);
    }

    #[test]
    fn cost_one_minute_voice_estimate() {
        // 1 分会話の概算: ユーザー音声 600 tokens + アシスタント音声 1200 tokens。
        let u = Usage {
            audio_input_tokens: 600,
            audio_output_tokens: 1200,
            ..Default::default()
        };
        // 600/1e6*32 + 1200/1e6*64 = 0.0192 + 0.0768 = 0.096 USD/分
        approx(u.cost_usd(), 0.096);
    }

    #[test]
    fn empty_usage_is_free() {
        approx(Usage::default().cost_usd(), 0.0);
    }

    #[test]
    fn add_usage_accumulates_within_month() {
        let mut t = CostTracker::new(BudgetConfig::default(), 202605);
        let u = Usage {
            audio_input_tokens: 1_000_000,
            ..Default::default()
        };
        approx(t.add_usage(&u, 202605), 32.0);
        approx(t.add_usage(&u, 202605), 64.0);
        assert_eq!(t.current_month, 202605);
    }

    #[test]
    fn month_rollover_resets_total() {
        let mut t = CostTracker::new(BudgetConfig::default(), 202605);
        let u = Usage {
            audio_input_tokens: 1_000_000,
            ..Default::default()
        };
        t.add_usage(&u, 202605);
        // 翌月になったら累計はリセットされ、その月の最初の usage だけが残る。
        approx(t.add_usage(&u, 202606), 32.0);
        assert_eq!(t.current_month, 202606);
    }

    #[test]
    fn disabled_budget_never_blocks() {
        let mut t = CostTracker::new(
            BudgetConfig {
                enabled: false,
                monthly_limit_usd: 1.0,
            },
            202605,
        );
        let big = Usage {
            audio_output_tokens: 100_000_000, // $6400
            ..Default::default()
        };
        t.add_usage(&big, 202605);
        assert!(!t.is_over_budget());
        assert!(t.can_start_session());
        assert_eq!(t.remaining_usd(), None);
    }

    #[test]
    fn over_budget_blocks_at_or_above_limit() {
        let mut t = CostTracker::new(
            BudgetConfig {
                enabled: true,
                monthly_limit_usd: 32.0,
            },
            202605,
        );
        let half = Usage {
            audio_input_tokens: 500_000, // $16
            ..Default::default()
        };
        // 上限未満なら開始可。
        t.add_usage(&half, 202605); // 累計 $16
        assert!(!t.is_over_budget());
        assert!(t.can_start_session());
        approx(t.remaining_usd().unwrap(), 16.0);

        // 上限ちょうど ($32) に達したらブロック（fail-closed）。
        t.add_usage(&half, 202605); // 累計 $32
        assert!(t.is_over_budget());
        assert!(!t.can_start_session());
        approx(t.remaining_usd().unwrap(), 0.0);
    }

    #[test]
    fn remaining_clamps_to_zero_when_exceeded() {
        let mut t = CostTracker::new(
            BudgetConfig {
                enabled: true,
                monthly_limit_usd: 10.0,
            },
            202605,
        );
        let over = Usage {
            audio_input_tokens: 1_000_000, // $32 >> $10
            ..Default::default()
        };
        t.add_usage(&over, 202605);
        // 残額は負にならず 0 にクランプ。
        approx(t.remaining_usd().unwrap(), 0.0);
        assert!(t.is_over_budget());
    }
}
