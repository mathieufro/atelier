/**
 * Creates click-outside detection logic for dropdown/popover components.
 *
 * Returns `startListening` / `stopListening` helpers that register or remove
 * a capture-phase document click handler. When a click lands outside the
 * container returned by `getContainer`, `onClose` is called.
 *
 * Callers should wire `onCleanup(stopListening)` for safety.
 */
export function createClickOutside(
  getContainer: () => HTMLElement | undefined,
  onClose: () => void,
) {
  function handleDocumentClick(e: MouseEvent) {
    const container = getContainer()
    if (container && !container.contains(e.target as Node)) {
      onClose()
    }
  }

  const startListening = () =>
    document.addEventListener("click", handleDocumentClick, true)
  const stopListening = () =>
    document.removeEventListener("click", handleDocumentClick, true)

  return { startListening, stopListening }
}
