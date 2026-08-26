/** Card builders shared by every screen (also keeps the bundle small: one template, many uses). */
export function card(title: string, body: string, cls = ''): string {
  return `<div class="card pad${cls ? ' ' + cls : ''}"><div class="card-title">${title}</div>${body}</div>`
}

export function headCard(head: string, body: string, cls = ''): string {
  return `<div class="card${cls ? ' ' + cls : ''}" style="overflow:hidden"><div class="card-head">${head}</div>${body}</div>`
}
