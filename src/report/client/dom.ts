/** Tiny DOM helpers shared by the shell and the screens. */

export function h(html: string): HTMLElement {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild as HTMLElement
}

/**
 * Put `aria-expanded` on every expandable summary and mirror it on toggle. Native <details> already
 * gives Enter/Space keyboard behaviour.
 */
export function wireExpandables(root: ParentNode): void {
  root.querySelectorAll<HTMLDetailsElement>('details').forEach((d) => {
    const s = d.querySelector('summary')
    if (!s) return
    s.setAttribute('role', 'button')
    s.setAttribute('aria-expanded', String(d.open))
    d.addEventListener('toggle', () => s.setAttribute('aria-expanded', String(d.open)))
  })
}

/** Copy text to the clipboard; flips the button label to "copied" for 1.2 s (design copyAny pattern). */
export function wireCopyButtons(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => {
    b.addEventListener('click', () => {
      const text = b.getAttribute('data-copy') ?? ''
      const done = () => {
        const prev = b.textContent
        b.textContent = 'copied'
        setTimeout(() => (b.textContent = prev), 1200)
      }
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done)
      else {
        const ta = document.createElement('textarea')
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        try {
          document.execCommand('copy')
        } catch {
          /* the visible text remains selectable */
        }
        ta.remove()
        done()
      }
    })
  })
}
