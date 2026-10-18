/** Papelera (hito 9, T3d, ADR-106): aviso a la cabecera para que vuelva a contar lo que hay en la papelera. */
export const TRASH_EVENT = 'wilox:trash';
export const trashChanged = () => window.dispatchEvent(new Event(TRASH_EVENT));
