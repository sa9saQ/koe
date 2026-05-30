// TDD tests for BudgetOnboarding component.
// BudgetOnboarding is now purely synchronous — it collects the budget choice
// and calls onBudgetChosen with the values; no IPC happens here.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// No IPC mock needed (component makes no IPC calls), but vi.mock keeps the
// module resolution consistent with the rest of the test suite.
vi.mock("../../lib/tauri/ipc", () => ({
  completeOnboarding: vi.fn(),
  getAppSettings: vi.fn(),
  saveBudgetConfig: vi.fn(),
  setOpenaiApiKey: vi.fn(),
  hasOpenaiApiKey: vi.fn(),
  deleteOpenaiApiKey: vi.fn(),
  setRecorderAdapter: vi.fn(),
}));

import { BudgetOnboarding } from "./BudgetOnboarding";

const onBudgetChosen = vi.fn();

beforeEach(() => {
  onBudgetChosen.mockReset();
});

describe("BudgetOnboarding", () => {
  it("次へ button is disabled until a choice is made", () => {
    render(<BudgetOnboarding onBudgetChosen={onBudgetChosen} />);
    const submit = screen.getByRole("button", { name: /次へ/i });
    expect(submit).toBeDisabled();
  });

  it("choosing unlimited enables the 次へ button", () => {
    render(<BudgetOnboarding onBudgetChosen={onBudgetChosen} />);
    // The wrapping <label> names the radio; query by the span text instead.
    fireEvent.click(screen.getByText("明示的に無制限（上限なし）").closest("label")!);
    expect(screen.getByRole("button", { name: /次へ/i })).not.toBeDisabled();
  });

  it("choosing limited requires a positive amount before 次へ is enabled", () => {
    render(<BudgetOnboarding onBudgetChosen={onBudgetChosen} />);
    fireEvent.click(screen.getByText("上限を設定する").closest("label")!);
    expect(screen.getByRole("button", { name: /次へ/i })).toBeDisabled();

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "10" } });
    expect(screen.getByRole("button", { name: /次へ/i })).not.toBeDisabled();
  });

  it("rejects zero amount", () => {
    render(<BudgetOnboarding onBudgetChosen={onBudgetChosen} />);
    fireEvent.click(screen.getByText("上限を設定する").closest("label")!);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: /次へ/i })).toBeDisabled();
  });

  it("rejects negative amount", () => {
    render(<BudgetOnboarding onBudgetChosen={onBudgetChosen} />);
    fireEvent.click(screen.getByText("上限を設定する").closest("label")!);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "-5" } });
    expect(screen.getByRole("button", { name: /次へ/i })).toBeDisabled();
  });

  it("rejects amount > 1_000_000 (UX upper bound)", () => {
    render(<BudgetOnboarding onBudgetChosen={onBudgetChosen} />);
    fireEvent.click(screen.getByText("上限を設定する").closest("label")!);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "1000001" } });
    expect(screen.getByRole("button", { name: /次へ/i })).toBeDisabled();
  });

  it("calls onBudgetChosen(true, amount) synchronously when limited is chosen", () => {
    render(<BudgetOnboarding onBudgetChosen={onBudgetChosen} />);
    fireEvent.click(screen.getByText("上限を設定する").closest("label")!);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /次へ/i }));

    expect(onBudgetChosen).toHaveBeenCalledWith(true, 50);
    // No async — called synchronously, not wrapped in act()
    expect(onBudgetChosen).toHaveBeenCalledTimes(1);
  });

  it("calls onBudgetChosen(false, null) when unlimited is chosen", () => {
    render(<BudgetOnboarding onBudgetChosen={onBudgetChosen} />);
    fireEvent.click(screen.getByText("明示的に無制限（上限なし）").closest("label")!);
    fireEvent.click(screen.getByRole("button", { name: /次へ/i }));

    expect(onBudgetChosen).toHaveBeenCalledWith(false, null);
  });
});
