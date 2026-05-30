// TDD tests for ApiKeyInput component.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setOpenaiApiKey = vi.fn();
const hasOpenaiApiKey = vi.fn();
const deleteOpenaiApiKey = vi.fn();

vi.mock("../../lib/tauri/ipc", () => ({
  setOpenaiApiKey: (...args: unknown[]) => setOpenaiApiKey(...args),
  hasOpenaiApiKey: (...args: unknown[]) => hasOpenaiApiKey(...args),
  deleteOpenaiApiKey: (...args: unknown[]) => deleteOpenaiApiKey(...args),
  getAppSettings: vi.fn(),
  completeOnboarding: vi.fn(),
  saveBudgetConfig: vi.fn(),
  setRecorderAdapter: vi.fn(),
}));

import { ApiKeyInput } from "./ApiKeyInput";

beforeEach(() => {
  setOpenaiApiKey.mockReset();
  hasOpenaiApiKey.mockReset();
  deleteOpenaiApiKey.mockReset();
  setOpenaiApiKey.mockResolvedValue(undefined);
  hasOpenaiApiKey.mockResolvedValue(false);
  deleteOpenaiApiKey.mockResolvedValue(undefined);
});

describe("ApiKeyInput", () => {
  it("renders a password input by default", () => {
    render(<ApiKeyInput />);
    // password inputs have no role="textbox"; query by type attribute directly
    const passwordInput = document.querySelector('input[type="password"]');
    expect(passwordInput).not.toBeNull();
  });

  it("toggles input type between password and text on show/hide click", () => {
    render(<ApiKeyInput />);
    const toggle = screen.getByRole("button", { name: /表示|非表示|show|hide/i });
    const input = document.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("password");

    fireEvent.click(toggle);
    expect(input.type).toBe("text");

    fireEvent.click(toggle);
    expect(input.type).toBe("password");
  });

  it("saves the key and clears the input on success", async () => {
    hasOpenaiApiKey.mockResolvedValue(true);
    render(<ApiKeyInput />);
    const input = document.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-test-key" } });

    const saveBtn = screen.getByRole("button", { name: /保存|save/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(setOpenaiApiKey).toHaveBeenCalledWith("sk-test-key");
    // Input must be cleared after save (key must not linger in DOM/state)
    expect(input.value).toBe("");
  });

  it("shows a fixed JP error message on IPC failure, does not leak raw error", async () => {
    setOpenaiApiKey.mockRejectedValue(new Error("internal/path/leaked sk-secret"));
    render(<ApiKeyInput />);
    const input = document.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-test-key" } });

    const saveBtn = screen.getByRole("button", { name: /保存|save/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    const alert = screen.getByRole("alert");
    expect(alert).not.toHaveTextContent("sk-secret");
    expect(alert).not.toHaveTextContent("/path");
    // Shows a fixed JP message
    expect(alert.textContent!.length).toBeGreaterThan(0);
  });

  it("confirms key presence via hasOpenaiApiKey after save", async () => {
    hasOpenaiApiKey.mockResolvedValue(true);
    render(<ApiKeyInput />);
    const input = document.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-test-key" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /保存|save/i }));
    });

    expect(hasOpenaiApiKey).toHaveBeenCalled();
  });

  it("calls deleteOpenaiApiKey when delete button is clicked", async () => {
    render(<ApiKeyInput hasKey={true} />);
    const deleteBtn = screen.getByRole("button", { name: /削除|delete/i });
    await act(async () => {
      fireEvent.click(deleteBtn);
    });
    expect(deleteOpenaiApiKey).toHaveBeenCalled();
  });

  it("does not show the saved key value in the DOM after save (key must not linger)", async () => {
    hasOpenaiApiKey.mockResolvedValue(true);
    render(<ApiKeyInput />);
    const input = document.querySelector("input") as HTMLInputElement;
    const secretKey = "sk-super-secret-12345";
    fireEvent.change(input, { target: { value: secretKey } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /保存|save/i }));
    });

    // The key value must not appear in the DOM after save
    await waitFor(() => {
      expect(document.body.innerHTML).not.toContain(secretKey);
    });
  });
});
