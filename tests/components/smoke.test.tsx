import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

function Hello() {
  return <div>Hello Test</div>;
}

describe("React rendering", () => {
  it("renders a component", () => {
    render(<Hello />);
    expect(screen.getByText("Hello Test")).toBeInTheDocument();
  });
});
