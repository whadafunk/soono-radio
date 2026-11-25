import { expect, it } from 'vitest';
import { joinMode } from './joinMode.js';

const a = { sampleRate: 22050, channels: 1, bitrateKbps: 64 };
const b = { sampleRate: 44100, channels: 2, bitrateKbps: 128 };

it('copies when every part has the same format', () => {
  expect(joinMode([a, { ...a }, { ...a }])).toEqual({ mode: 'copy' });
  expect(joinMode([b])).toEqual({ mode: 'copy' });
});
it('re-encodes to the best format present when parts differ', () => {
  expect(joinMode([a, b, a])).toEqual({ mode: 'reencode', sampleRate: 44100, channels: 2, bitrateKbps: 128 });
});
it('re-encodes when only the bitrate differs', () => {
  expect(joinMode([a, { ...a, bitrateKbps: 96 }])).toEqual({ mode: 'reencode', sampleRate: 22050, channels: 1, bitrateKbps: 96 });
});
it('keeps the result encodable: 192 kbps cannot go with 22.05 kHz', () => {
  expect(joinMode([{ sampleRate: 22050, channels: 1, bitrateKbps: 64 }, { sampleRate: 44100, channels: 1, bitrateKbps: 192 }]))
    .toEqual({ mode: 'reencode', sampleRate: 44100, channels: 1, bitrateKbps: 192 });
});
