/**
 * A newly opened XLSX grid takes the keyboard as a new DOCX session does
 * (Q690): only through its frame, since focusing from a frame without the
 * focus would take it from Capy's page. At once if the frame has the focus,
 * else when it first gets it (Capy focuses it on `collaboration-ready` unless
 * its own focus is somewhere it keeps, or a click into the frame, whose target
 * then keeps it), and only while nothing in the frame has it. Returns what
 * stops waiting.
 */
export function takeKeyboard(focus: () => void, frame: Window = window) {
  const take = () => {
    const { activeElement, body } = frame.document;
    if (!activeElement || activeElement === body) focus();
  };
  if (frame.document.hasFocus()) take();
  else frame.addEventListener('focus', take, { once: true });
  return () => frame.removeEventListener('focus', take);
}
