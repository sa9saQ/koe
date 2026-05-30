// Tests for AdapterSelector component.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdapterSelector } from "./AdapterSelector";

describe("AdapterSelector", () => {
  it("renders the sqlite option as selected by default", () => {
    render(<AdapterSelector value="sqlite" />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("sqlite");
  });

  it("shows future adapters as disabled", () => {
    render(<AdapterSelector value="sqlite" />);
    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    const unavailable = options.filter((o) => o.disabled);
    expect(unavailable.length).toBeGreaterThan(0);
  });

  it("calls onChange when a new adapter is selected", () => {
    const onChange = vi.fn();
    render(<AdapterSelector value="sqlite" onChange={onChange} />);
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "sqlite" } });
    expect(onChange).toHaveBeenCalledWith("sqlite");
  });

  it("is disabled when disabled prop is true", () => {
    render(<AdapterSelector value="sqlite" disabled={true} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });
});
