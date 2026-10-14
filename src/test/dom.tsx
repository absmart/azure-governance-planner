// Helpers for the jsdom UI tests (files with `// @vitest-environment jsdom`):
// mount a component and drive it the way a user would.

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom's Blob has no text().
if (typeof Blob !== 'undefined' && !Blob.prototype.text)
  Blob.prototype.text = function (this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };

const mounted: { root: Root; container: HTMLElement }[] = [];

export function mount(element: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mounted.push({ root, container });
  return container;
}

/** Unmounts everything mount() rendered; call it in afterEach. */
export function unmountAll() {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

/** Clicks an element; works for SVG elements, which have no click(). */
export function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** Types a value into an input or textarea, or picks an option of a select. */
export function setValue(el: Element, value: string) {
  const field = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

/** Moves focus out of a field, for editors that apply on blur. */
export function blur(el: Element) {
  act(() => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

const matches = (el: Element, text: string | RegExp) => {
  const content = el.textContent ?? '';
  return typeof text === 'string' ? content.includes(text) : text.test(content);
};

/** Every element matching the selector whose text contains (or matches) text. */
export function allByText<T extends Element = HTMLElement>(root: ParentNode, selector: string, text: string | RegExp): T[] {
  return [...root.querySelectorAll<T>(selector)].filter((el) => matches(el, text));
}

/** The first element matching the selector whose text contains (or matches) text; throws if there is none. */
export function byText<T extends Element = HTMLElement>(root: ParentNode, selector: string, text: string | RegExp): T {
  const found = allByText<T>(root, selector, text)[0];
  if (!found) {
    const seen = [...root.querySelectorAll(selector)].map((el) => (el.textContent ?? '').trim().slice(0, 60)).slice(0, 30);
    throw new Error(`No ${selector} with text ${String(text)}. Saw: ${JSON.stringify(seen)}`);
  }
  return found;
}

/** The form control inside the <label> whose text contains text. */
export function field<T extends Element = HTMLInputElement>(root: ParentNode, text: string | RegExp): T {
  const control = byText(root, 'label', text).querySelector<T>('input, select, textarea');
  if (!control) throw new Error(`The label ${String(text)} has no control.`);
  return control;
}

/** Waits until check() returns something truthy, letting React and promises run. */
export async function until<T>(check: () => T | null | undefined | false, timeout = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    let value: T | null | undefined | false;
    try {
      value = check();
    } catch {
      value = undefined;
    }
    if (value) return value;
    if (Date.now() - start > timeout) return check() as T;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}
