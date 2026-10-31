import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BRAND, brandName, brandText, setBrandName } from '../src/lib/brandText.ts';
import { brandSlot } from '../src/lib/brandSlots.ts';

test('the former brand in texts becomes the brand name', () => {
	assert.equal(brandText('Welcome to Nihtan', 'Diko'), 'Welcome to Diko');
	assert.equal(brandText('NIHTAN LIVE', 'Diko'), 'DIKO LIVE');
	assert.equal(brandText('欢迎来到泥炭', 'Diko'), '欢迎来到Diko');
	assert.equal(brandText('<span>泥炭(Nihtan)牌</span>', 'Diko'), '<span>Diko(Diko)牌</span>');
	// lowercase is code (keys, files, domains), never a name
	assert.equal(brandText('nihtanjunket_lobby_close /img/nihtan-logo.png lobby.nihtanv2.com', 'Diko'), 'nihtanjunket_lobby_close /img/nihtan-logo.png lobby.nihtanv2.com');
	assert.equal(brandText('', 'Diko'), '');
});

test('the current name: set by the admin, Diko by default', () => {
	setBrandName('Royal Club');
	assert.equal(brandName(), 'Royal Club');
	assert.equal(brandText('Nihtan Poker'), 'Royal Club Poker');
	setBrandName('   ');
	assert.equal(brandName(), DEFAULT_BRAND);
	setBrandName(null);
	assert.equal(brandName(), 'Diko');
});

test('brand slots: the files that show the brand, nothing else', () => {
	assert.deepEqual(brandSlot('poker/img/nihtan-logo.png'), { kind : 'wordmark', colour : '#d22e21' });
	assert.equal(brandSlot('lobby/img/header/logo.png')!.kind, 'wordmark');
	assert.equal(brandSlot('baccarat/img/confirmation/nihtan-yellow_logo.png')!.kind, 'wordmark');
	assert.equal(brandSlot('dragon-tiger/img/maintenance/logo.png')!.kind, 'wordmark');
	assert.equal(brandSlot('lobby/img/nihtan_logo_mobile.png')!.kind, 'mark');
	assert.equal(brandSlot('poker/favicon.ico')!.kind, 'mark');
	assert.deepEqual(brandSlot('shared/app/icon-maskable-512.png'), { kind : 'icon', scale : 0.46, background : true });
	assert.deepEqual(brandSlot('lobby/sound/kr/mode-2/welcome-nihtan.mp3'), { kind : 'welcome', lang : 'kr' });
	for (const other of ['lobby/img/kirin_vip_logo.png', 'baccarat/img/cards/back-banker.png', 'lobby/img/seasonal_theme/christmas_theme/logo_web.png',
		'poker/img/nihtan-logo.png.map', 'lobby/sound/en/mode-1/bet-start.mp3', 'shared/app/offline.html', '../lobby/img/nihtan_logo.png']) {
		assert.equal(brandSlot(other), null, other);
	}
});
