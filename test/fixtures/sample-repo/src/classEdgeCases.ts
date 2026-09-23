import { Component, HostListener, Input } from "some-framework";

@Component({ selector: "app-root" })
export class AppComponent {
  @Input() title: string = "app";
  #renderCount = 0;
  static instanceCount = 0;

  constructor(private readonly service: DataService) {
    AppComponent.instanceCount++;
  }

  @HostListener("click", ["$event"])
  async onClick(event: MouseEvent): Promise<void> {
    this.#renderCount++;
    await this.service.notify(event);
    console.log("clicked", event, this.#renderCount);
  }

  get renderCount(): number {
    return this.#renderCount;
  }

  set renderCount(value: number) {
    this.#renderCount = value;
  }

  *values(): Generator<number> {
    yield 1;
    yield 2;
    yield 3;
  }

  [Symbol.iterator]() {
    return this.values();
  }

  static {
    console.log("AppComponent static init block running");
  }

  private helper(): void {
    console.log("helper called", this.title);
  }
}

export abstract class Shape {
  abstract area(): number;

  describe(): string {
    return `area = ${this.area()}`;
  }
}

export const Counter = class {
  #count = 0;

  increment(): number {
    this.#count += 1;
    return this.#count;
  }

  reset(): void {
    this.#count = 0;
  }
};
