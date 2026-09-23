/** Small in-page driver for developer journeys. Every action reaches the real
 * DOM handler; no error component is mounted or assigned an error by the driver. */
export function scenarioDriver(signal: AbortSignal, root: Document = document) {
  const visible = (element: Element) =>
    !element.closest(
      '[data-testid="mock-scenario-panel"], [inert], [aria-hidden="true"]'
    ) && element.getClientRects().length > 0;

  const wait = <T>(
    read: () => T | null | undefined | false,
    description: string
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: T) => {
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value!);
      };
      const check = () => {
        try {
          signal.throwIfAborted();
          const value = read();
          if (value) finish(undefined, value);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const abort = () =>
        finish(new DOMException('Scenario cancelled', 'AbortError'));
      const observer = new MutationObserver(check);
      observer.observe(root, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      // Readiness also includes non-DOM state such as collaboration receipts.
      const poll = setInterval(check, 100);
      const timeout = setTimeout(
        () => finish(new Error(`Scenario setup timed out: ${description}`)),
        30_000
      );
      signal.addEventListener('abort', abort, { once: true });
      check();
    });
  const element = <T extends HTMLElement = HTMLElement>(selector: string) =>
    wait(() => [...root.querySelectorAll<T>(selector)].find(visible), selector);
  const button = (
    name: string,
    selector = 'button, [role="menuitem"], [role="option"], [role="tab"]'
  ) =>
    wait(
      () =>
        [...root.querySelectorAll<HTMLElement>(selector)].find(
          (node) =>
            visible(node) &&
            !node.matches(':disabled, [aria-disabled="true"]') &&
            (node.getAttribute('aria-label') === name ||
              node.textContent?.trim() === name ||
              [...node.childNodes].some(
                (child) =>
                  child.nodeType === Node.TEXT_NODE &&
                  child.textContent?.trim() === name
              ))
        ),
      `button ${name}`
    );
  const activate = (node: HTMLElement) => {
    signal.throwIfAborted();
    if (node.getAttribute('aria-haspopup') === 'menu') {
      node.focus();
      node.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
        })
      );
    } else node.click();
  };
  return {
    activate,
    button,
    async click(name: string, selector?: string) {
      activate(await button(name, selector));
    },
    element,
    async fill(selector: string, value: string) {
      const input = await element<HTMLInputElement | HTMLTextAreaElement>(
        selector
      );
      signal.throwIfAborted();
      const prototype =
        input.tagName === 'TEXTAREA'
          ? root.defaultView!.HTMLTextAreaElement.prototype
          : root.defaultView!.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
        input,
        value
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input;
    },
    async submit(selector = 'form') {
      const form = await element<HTMLFormElement>(selector);
      await wait(
        () => !form.querySelector('button[type="submit"]:disabled'),
        'form enabled'
      );
      signal.throwIfAborted();
      form.requestSubmit();
    },
    wait,
  };
}
