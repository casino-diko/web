/*
 |--------------------------------------------------------------------------
 | table notices
 |--------------------------------------------------------------------------
 | public/shared/table-notices/table-notices.js (window.tgNotice) shows the
 | game-server's round cancels, voids and last rounds countdown on every
 | game page. renderPage() adds it, with these texts, to the game apps'
 | pages; {amount} {round} {n} are filled in by the script.
 |
 */

import type { App } from './config';
import { LOCALES } from './i18n';

const TEXTS: Record<string, Record<string, string>> = {
	en : {
		cancelled     : 'Round cancelled',
		cancelledBody : 'All bets in this round have been refunded.',
		refundedYou   : '{amount} has been returned to your balance.',
		voided        : 'Round {round} voided',
		voidedBody    : 'Bets and winnings of this round have been reversed.',
		roundsLeft    : '{n} rounds left',
		lastRound     : 'Last round'
	},
	kr : {
		cancelled     : '라운드 취소',
		cancelledBody : '이번 라운드의 모든 베팅이 환불되었습니다.',
		refundedYou   : '{amount}이(가) 잔액으로 반환되었습니다.',
		voided        : '{round} 라운드 무효',
		voidedBody    : '이번 라운드의 베팅과 당첨금이 취소되었습니다.',
		roundsLeft    : '남은 라운드 {n}',
		lastRound     : '마지막 라운드'
	},
	jp : {
		cancelled     : 'ラウンド中止',
		cancelledBody : 'このラウンドのベットはすべて返金されました。',
		refundedYou   : '{amount} が残高に戻りました。',
		voided        : 'ラウンド {round} 無効',
		voidedBody    : 'このラウンドのベットと配当は取り消されました。',
		roundsLeft    : '残り {n} ラウンド',
		lastRound     : '最終ラウンド'
	},
	zh : {
		cancelled     : '本局取消',
		cancelledBody : '本局所有投注已退还。',
		refundedYou   : '{amount} 已退回您的余额。',
		voided        : '第 {round} 局作废',
		voidedBody    : '本局的投注与派彩已撤销。',
		roundsLeft    : '剩余 {n} 局',
		lastRound     : '最后一局'
	},
	th : {
		cancelled     : 'ยกเลิกรอบนี้',
		cancelledBody : 'เดิมพันทั้งหมดในรอบนี้ได้รับคืนแล้ว',
		refundedYou   : 'คืน {amount} เข้ายอดเงินของคุณแล้ว',
		voided        : 'รอบ {round} เป็นโมฆะ',
		voidedBody    : 'เดิมพันและเงินรางวัลของรอบนี้ถูกยกเลิกแล้ว',
		roundsLeft    : 'เหลืออีก {n} รอบ',
		lastRound     : 'รอบสุดท้าย'
	}
};

export const noticeTexts = (locale: string) => TEXTS[LOCALES.includes(locale) && TEXTS[locale] ? locale : 'en'];

// JSON inside <script>: "</script>" and the line / paragraph separators must not end or break it
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const scriptJson = (value: unknown) => JSON.stringify(value)
	.replace(/</g, '\\u003c')
	.split(LS).join('\\u2028')
	.split(PS).join('\\u2029');

/** adds the notices to a game page (before </head>); the lobby and fragments stay as they are */
export function withTableNotices (html: string, app: App, locale: string): string {
	if (app === 'lobby' || !/<\/head>/i.test(html)) return html;
	// also the table's dealer, standing behind the betting table (public/shared/table-dealer)
	const tags = `<script>window.tgNoticeText=${scriptJson(noticeTexts(locale))};</script>\n`
		+ '<script src="/shared/table-notices/table-notices.js" defer></script>\n'
		+ '<script src="/shared/table-dealer/table-dealer.js"></script>\n';
	return html.replace(/<\/head>/i, m => tags + m);
}
