import html2canvas from 'html2canvas'

export async function captureScreenshot(elementsToHide = []) {
  // Hide the widget UI before capturing so it doesn't appear in the screenshot
  elementsToHide.forEach((el) => { if (el) el.style.visibility = 'hidden' })

  // Allow the DOM to repaint before capture
  await new Promise((r) => setTimeout(r, 150))

  try {
    const canvas = await html2canvas(document.body, {
      useCORS: true,
      scale: 0.8,
      backgroundColor: '#ffffff',
      removeContainer: true,
      ignoreElements: (el) =>
        el.classList && (
          el.classList.contains('bp-dialog') ||
          el.classList.contains('bp-backdrop') ||
          el.classList.contains('bp-trigger')
        ),
    })
    return canvas.toDataURL('image/png', 0.85)
  } finally {
    elementsToHide.forEach((el) => { if (el) el.style.visibility = '' })
  }
}
