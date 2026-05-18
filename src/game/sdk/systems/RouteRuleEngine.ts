import type { Leg, MoveIntent } from "../types";
import type { RouteRule, RouteRuleContext } from "./route-rules";
import { ROUTE_RULES } from "./route-rules";

export class RouteRuleEngine {
  private rules: RouteRule[];

  constructor(rules: RouteRule[] = ROUTE_RULES) {
    this.rules = [...rules].sort((a, b) => b.priority - a.priority);
  }

  addRule(rule: RouteRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  removeRule(id: string): void {
    this.rules = this.rules.filter((r) => r.id !== id);
  }

  process(intent: MoveIntent, ctx: RouteRuleContext, baseLeg: Leg[]): Leg[] {
    let legs = baseLeg;
    for (const rule of this.rules) {
      if (rule.matches(intent, ctx)) {
        legs = rule.apply(legs, intent, ctx);
      }
    }
    return legs;
  }
}
