export function insertAtCaret(text: string) {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return;
  const isEditable =
    el.getAttribute("contenteditable") === "" ||
    el.getAttribute("contenteditable") === "true";

  if (
    ((el as HTMLInputElement).selectionStart !== undefined &&
      el instanceof HTMLTextAreaElement) ||
    el instanceof HTMLInputElement
  ) {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.substring(0, start);
    const after = input.value.substring(end);
    input.value = `${before}${text}${after}`;
    const caret = start + text.length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  if (isEditable) {
    document.execCommand("insertText", false, text);
  }
}

export function handleTranscriptMessage(msg: {
  interim?: boolean;
  text: string;
}) {
  const toInsert = msg.interim ? msg.text : msg.text + " ";
  insertAtCaret(toInsert);
}
