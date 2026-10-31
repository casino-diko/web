/*
 |--------------------------------------------------------------------------
 | brand name in text
 |--------------------------------------------------------------------------
 | The former brand ("Nihtan", "NIHTAN", Chinese 泥炭) in the translations
 | becomes the brand name the admin back-office sets (lib/brand.ts keeps it
 | current). Only those spellings: the lowercase "nihtan" is code (keys such
 | as nihtanjunket_*, file names, variables), never shown to players.
 | Pure (no database): lib/i18n.ts and the tests import it.
 |
 */

export const DEFAULT_BRAND = 'Diko';

let current = DEFAULT_BRAND;

export const brandName = () => current;

export function setBrandName (name: string | null | undefined) {
	current = (name || '').trim() || DEFAULT_BRAND;
}

export function brandText (text: string, name = current): string {
	if (!text || !/Nihtan|NIHTAN|泥炭/.test(text)) return text;
	return text.replace(/NIHTAN/g, name.toUpperCase()).replace(/Nihtan|泥炭/g, name);
}
