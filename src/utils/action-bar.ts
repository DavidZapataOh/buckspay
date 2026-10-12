/** The space under a row of action buttons: clear of the system bar, and never less than 24. */
export const actionBarPadding = (bottomInset: number): number => Math.max(24, bottomInset + 8)
