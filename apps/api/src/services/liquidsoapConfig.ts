import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { parseStringPromise } from 'xml2js';
import Handlebars from 'handlebars';
import { LiquidsoapConfig, LiquidsoapConfigSchema } from '@soono/shared';

const CONFIG_PATH =
  process.env.LIQUIDSOAP_CONFIG ||
  join(process.cwd(), '..', '..', 'liquidsoap', 'supervisor.json');

const SCRIPT_PATH =
  process.env.LIQUIDSOAP_SCRIPT ||
  join(process.cwd(), '..', '..', 'liquidsoap', 'mix-engine.liq');

const TEMPLATE_PATH =
  process.env.LIQUIDSOAP_TEMPLATE ||
  join(process.cwd(), '..', '..', 'liquidsoap', 'mix-engine.liq.hbs');

const ICECAST_CONFIG_PATH =
  process.env.ICECAST_CONFIG ||
  join(process.cwd(), '..', '..', 'icecast', 'icecast.xml');

// LiquidSoap 2.2.5 does not coerce an int literal to a {float}-typed argument
// (e.g. `ratio=20` fails to compile where `ratio=20.0` is required) — confirmed
// against the actual v2.2.5 binary. JS numbers that happen to be whole (20, -1)
// stringify without a decimal point, so every float-typed argument interpolated
// into the template must go through this helper rather than a bare {{path}}.
Handlebars.registerHelper('float', (value: number) => (Number.isInteger(value) ? `${value}.0` : `${value}`));

const DEFAULT_CONFIG: LiquidsoapConfig = LiquidsoapConfigSchema.parse({
  output: {},
  harbor: { password: 'changeme' },
  automation: {},
  crossfade: {},
});

export async function readLiquidsoapConfig(): Promise<LiquidsoapConfig> {
  try {
    const json = await readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(json);
    return LiquidsoapConfigSchema.parse(parsed);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return DEFAULT_CONFIG;
    }
    throw err;
  }
}

export async function writeLiquidsoapConfig(config: LiquidsoapConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  await generateRadioLiq(config);
}

async function readIcecastSourcePassword(): Promise<string> {
  const xml = await readFile(ICECAST_CONFIG_PATH, 'utf-8');
  const parsed = await parseStringPromise(xml, { trim: true });
  const password = parsed?.icecast?.authentication?.[0]?.['source-password']?.[0];
  if (!password) {
    throw new Error('Could not read source-password from icecast.xml');
  }
  return password;
}

export async function generateRadioLiq(config: LiquidsoapConfig): Promise<string> {
  const [sourcePassword, templateSource] = await Promise.all([
    readIcecastSourcePassword(),
    readFile(TEMPLATE_PATH, 'utf-8'),
  ]);
  const script = renderScript(templateSource, config, sourcePassword);
  await writeFile(SCRIPT_PATH, script, 'utf-8');
  return script;
}

function renderScript(templateSource: string, config: LiquidsoapConfig, icecastSourcePassword: string): string {
  const apiUrl = process.env.LS_API_URL ?? 'http://host.docker.internal:3000';

  // Precompute the TLS transport parameter — it's an inline trailing argument
  // inside input.harbor() so a block helper would produce awkward whitespace.
  const harbor_tls_transport =
    config.harbor.tls.enabled && config.harbor.tls.certificate_path
      ? `,\n  transport=ssl.transport(certificate="${escapeStr(config.harbor.tls.certificate_path)}", key="${escapeStr(config.harbor.tls.certificate_path)}")`
      : '';

  const context = {
    ...config,
    api_url: apiUrl,
    icecast_source_password: escapeStr(icecastSourcePassword),
    codec_string: formatCodec(config.output.codec, config.output.bitrate_kbps),
    crossfade_enabled: config.crossfade.duration_seconds > 0,
    harbor_and_ducking: config.harbor.enabled && config.ducking.enabled,
    harbor_tls_transport,
  };

  // noEscape: we're generating a script file, not HTML.
  const template = Handlebars.compile(templateSource, { noEscape: true });
  return template(context);
}

function formatCodec(codec: string, bitrate: number): string {
  switch (codec) {
    case 'mp3':
      return `%mp3(bitrate=${bitrate}, samplerate=44100, stereo=true)`;
    case 'aac':
      return `%fdkaac(bitrate=${bitrate}, samplerate=44100, channels=2)`;
    case 'opus':
      return `%opus(bitrate=${bitrate}, samplerate=48000, channels=2, application="audio")`;
    case 'vorbis':
      return `%vorbis(quality=0.5, samplerate=44100, channels=2)`;
    default:
      return `%mp3(bitrate=${bitrate}, samplerate=44100, stereo=true)`;
  }
}

function escapeStr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function readRadioLiq(): Promise<string> {
  return readFile(SCRIPT_PATH, 'utf-8');
}

export async function writeRadioLiq(content: string): Promise<void> {
  await writeFile(SCRIPT_PATH, content, 'utf-8');
}
