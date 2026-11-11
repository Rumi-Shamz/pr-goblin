export function captureContext() {
  const ua = navigator.userAgent
  return {
    url: window.location.href,
    referrer: document.referrer || null,
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
    },
    screen: {
      w: screen.width,
      h: screen.height,
    },
    userAgent: ua,
    browser: parseBrowser(ua),
    os: parseOS(ua),
    timestamp: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
  }
}

function parseBrowser(ua) {
  if (/Edg\//.test(ua)) return 'Edge'
  if (/Chrome\//.test(ua)) return 'Chrome'
  if (/Firefox\//.test(ua)) return 'Firefox'
  if (/Safari\//.test(ua) && !/Chrome/.test(ua)) return 'Safari'
  if (/OPR\/|Opera\//.test(ua)) return 'Opera'
  return 'Unknown'
}

function parseOS(ua) {
  if (/Windows NT/.test(ua)) return 'Windows'
  if (/Mac OS X/.test(ua)) return 'macOS'
  if (/Android/.test(ua)) return 'Android'
  if (/iPhone|iPad/.test(ua)) return 'iOS'
  if (/Linux/.test(ua)) return 'Linux'
  return 'Unknown'
}
