'use client';

export type ProviderProtocol = 'google' | 'openai';
export type ImageOutputSize = '512' | '1K' | '2K' | '4K';
export type BuiltinImagePresetId =
  | 'gemini-2.5-flash-image'
  | 'gemini-3-pro-image-preview'
  | 'gemini-3.1-flash-image-preview'
  | 'gpt-image-2'
  | 'gpt-image-2-fast'
  | 'gpt-image-2-plus'
  | 'gpt-image-2-pro';

export interface ProviderSettings {
  protocol: ProviderProtocol;
  apiKey: string;
  baseUrl: string;
}

export interface ProviderRegistry {
  google: ProviderSettings;
  openai: ProviderSettings;
}

export interface BuiltinImagePreset {
  id: BuiltinImagePresetId;
  protocol: ProviderProtocol;
  name: string;
  modelId: string;
  maxRefImages: number;
  maxOutputSize: ImageOutputSize;
  supportsAdvancedParams: boolean;
  advancedParamsEnabledByDefault: boolean;
}

export interface ImageModelConfig {
  id: string;
  protocol: ProviderProtocol;
  name: string;
  modelId: string;
  builtinPreset: BuiltinImagePresetId;
  maxRefImages: number;
  maxOutputSize: ImageOutputSize;
  supportsAdvancedParams: boolean;
  advancedParamsEnabledByDefault: boolean;
}

export interface TextModelConfig {
  id: string;
  protocol: ProviderProtocol;
  name: string;
  modelId: string;
  note?: string;
}

export interface DefaultModels {
  textToImage: string;
  imageToImage: string;
  reversePrompt: string;
  agent: string;
  promptOptimize: string;
  imageDescribe: string;
}

export interface NovaModelRegistry {
  providers: ProviderRegistry;
  imageModels: ImageModelConfig[];
  textModels: TextModelConfig[];
  defaults: DefaultModels;
}

const REGISTRY_KEY = 'nova-model-registry';

export const DEFAULT_PROVIDERS: ProviderRegistry = {
  google: {
    protocol: 'google',
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com',
  },
  openai: {
    protocol: 'openai',
    apiKey: '',
    baseUrl: 'https://api.openai.com',
  },
};

export const BUILTIN_IMAGE_PRESETS: Record<BuiltinImagePresetId, BuiltinImagePreset> = {
  'gemini-2.5-flash-image': {
    id: 'gemini-2.5-flash-image',
    protocol: 'google',
    name: 'Banana',
    modelId: 'gemini-2.5-flash-image',
    maxRefImages: 3,
    maxOutputSize: '1K',
    supportsAdvancedParams: false,
    advancedParamsEnabledByDefault: false,
  },
  'gemini-3-pro-image-preview': {
    id: 'gemini-3-pro-image-preview',
    protocol: 'google',
    name: 'Banana Pro',
    modelId: 'gemini-3-pro-image-preview',
    maxRefImages: 11,
    maxOutputSize: '4K',
    supportsAdvancedParams: false,
    advancedParamsEnabledByDefault: false,
  },
  'gemini-3.1-flash-image-preview': {
    id: 'gemini-3.1-flash-image-preview',
    protocol: 'google',
    name: 'Banana 2',
    modelId: 'gemini-3.1-flash-image-preview',
    maxRefImages: 14,
    maxOutputSize: '4K',
    supportsAdvancedParams: false,
    advancedParamsEnabledByDefault: false,
  },
  'gpt-image-2': {
    id: 'gpt-image-2',
    protocol: 'openai',
    name: 'GPT Image 2',
    modelId: 'gpt-image-2',
    maxRefImages: 6,
    maxOutputSize: '1K',
    supportsAdvancedParams: false,
    advancedParamsEnabledByDefault: false,
  },
  'gpt-image-2-fast': {
    id: 'gpt-image-2-fast',
    protocol: 'openai',
    name: 'GPT Image 2 Fast',
    modelId: 'gpt-image-2-fast',
    maxRefImages: 6,
    maxOutputSize: '1K',
    supportsAdvancedParams: true,
    advancedParamsEnabledByDefault: true,
  },
  'gpt-image-2-plus': {
    id: 'gpt-image-2-plus',
    protocol: 'openai',
    name: 'GPT Image 2 Plus',
    modelId: 'gpt-image-2-plus',
    maxRefImages: 10,
    maxOutputSize: '4K',
    supportsAdvancedParams: true,
    advancedParamsEnabledByDefault: true,
  },
  'gpt-image-2-pro': {
    id: 'gpt-image-2-pro',
    protocol: 'openai',
    name: 'GPT Image 2 Pro',
    modelId: 'gpt-image-2-pro',
    maxRefImages: 16,
    maxOutputSize: '4K',
    supportsAdvancedParams: false,
    advancedParamsEnabledByDefault: false,
  },
};

export const BUILTIN_IMAGE_PRESET_OPTIONS = Object.values(BUILTIN_IMAGE_PRESETS).map((preset) => ({
  value: preset.id,
  label: preset.name,
}));

function createBuiltinImageModelConfig(presetId: BuiltinImagePresetId): ImageModelConfig {
  const preset = BUILTIN_IMAGE_PRESETS[presetId];
  return {
    id: preset.id,
    protocol: preset.protocol,
    name: preset.name,
    modelId: preset.modelId,
    builtinPreset: preset.id,
    maxRefImages: preset.maxRefImages,
    maxOutputSize: preset.maxOutputSize,
    supportsAdvancedParams: preset.supportsAdvancedParams,
    advancedParamsEnabledByDefault: preset.advancedParamsEnabledByDefault,
  };
}

export const DEFAULT_IMAGE_MODELS: ImageModelConfig[] = Object.keys(BUILTIN_IMAGE_PRESETS).map((presetId) => (
  createBuiltinImageModelConfig(presetId as BuiltinImagePresetId)
));

export const DEFAULT_TEXT_MODELS: TextModelConfig[] = [
  {
    id: 'gpt-4o-mini',
    protocol: 'openai',
    name: 'GPT 4o Mini',
    modelId: 'gpt-4o-mini',
    note: 'OpenAI Responses',
  },
  {
    id: 'gpt-5.4-mini-c',
    protocol: 'openai',
    name: 'GPT 5.4 Mini C',
    modelId: 'gpt-5.4-mini-c',
    note: '适合提示词优化与 Agent',
  },
  {
    id: 'gemini-2.5-flash',
    protocol: 'google',
    name: 'Gemini 2.5 Flash',
    modelId: 'gemini-2.5-flash',
  },
];

export const DEFAULT_DEFAULTS: DefaultModels = {
  textToImage: 'gemini-3-pro-image-preview',
  imageToImage: 'gemini-3-pro-image-preview',
  reversePrompt: 'gpt-4o-mini',
  agent: 'gpt-5.4-mini-c',
  promptOptimize: 'gpt-5.4-mini-c',
  imageDescribe: 'gpt-5.4-mini-c',
};

function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return value === 'google' || value === 'openai';
}

function isBuiltinImagePresetId(value: unknown): value is BuiltinImagePresetId {
  return typeof value === 'string' && value in BUILTIN_IMAGE_PRESETS;
}

function normalizeImageOutputSize(value: unknown, fallback: ImageOutputSize): ImageOutputSize {
  return value === '512' || value === '1K' || value === '2K' || value === '4K'
    ? value
    : fallback;
}

function inferBuiltinPresetId(raw: Partial<ImageModelConfig> & { supportedOutputSizes?: unknown }): BuiltinImagePresetId {
  const candidate = raw.builtinPreset || raw.id || raw.modelId;
  if (isBuiltinImagePresetId(candidate)) return candidate;

  const normalizedModelId = String(raw.modelId || raw.id || '').trim();
  if (isBuiltinImagePresetId(normalizedModelId)) return normalizedModelId;

  const outputSizes = Array.isArray(raw.supportedOutputSizes)
    ? raw.supportedOutputSizes.filter((item): item is ImageOutputSize => item === '512' || item === '1K' || item === '2K' || item === '4K')
    : [];
  if (outputSizes.includes('512')) return 'gemini-3.1-flash-image-preview';
  if (String(raw.protocol || '').trim() === 'google') return 'gemini-3-pro-image-preview';
  return 'gpt-image-2-plus';
}

function normalizeImageModelConfig(raw: Partial<ImageModelConfig> & { supportedOutputSizes?: unknown }): ImageModelConfig {
  const presetId = inferBuiltinPresetId(raw);
  const preset = BUILTIN_IMAGE_PRESETS[presetId];
  return {
    id: String(raw.id || raw.modelId || generateModelId()).trim(),
    protocol: isProviderProtocol(raw.protocol) ? raw.protocol : preset.protocol,
    name: String(raw.name || preset.name).trim(),
    modelId: String(raw.modelId || preset.modelId).trim(),
    builtinPreset: presetId,
    maxRefImages: Number.isFinite(raw.maxRefImages) && Number(raw.maxRefImages) > 0
      ? Math.max(1, Math.floor(Number(raw.maxRefImages)))
      : preset.maxRefImages,
    maxOutputSize: normalizeImageOutputSize(
      raw.maxOutputSize,
      Array.isArray(raw.supportedOutputSizes) && raw.supportedOutputSizes.length > 0
        ? normalizeImageOutputSize(raw.supportedOutputSizes[raw.supportedOutputSizes.length - 1], preset.maxOutputSize)
        : preset.maxOutputSize,
    ),
    supportsAdvancedParams: typeof raw.supportsAdvancedParams === 'boolean'
      ? raw.supportsAdvancedParams
      : preset.supportsAdvancedParams,
    advancedParamsEnabledByDefault: typeof raw.advancedParamsEnabledByDefault === 'boolean'
      ? raw.advancedParamsEnabledByDefault
      : preset.advancedParamsEnabledByDefault,
  };
}

function normalizeTextModelConfig(raw: Partial<TextModelConfig>): TextModelConfig | null {
  const id = String(raw.id || raw.modelId || '').trim();
  const name = String(raw.name || raw.modelId || '').trim();
  const modelId = String(raw.modelId || '').trim();
  if (!id || !name || !modelId) return null;

  return {
    id,
    protocol: isProviderProtocol(raw.protocol) ? raw.protocol : 'openai',
    name,
    modelId,
    note: typeof raw.note === 'string' ? raw.note : '',
  };
}

function ensureProviders(raw?: Partial<ProviderRegistry>): ProviderRegistry {
  const google: Partial<ProviderSettings> = raw?.google || {};
  const openai: Partial<ProviderSettings> = raw?.openai || {};
  return {
    google: {
      protocol: 'google',
      apiKey: String(google.apiKey || DEFAULT_PROVIDERS.google.apiKey),
      baseUrl: String(google.baseUrl || DEFAULT_PROVIDERS.google.baseUrl),
    },
    openai: {
      protocol: 'openai',
      apiKey: String(openai.apiKey || DEFAULT_PROVIDERS.openai.apiKey),
      baseUrl: String(openai.baseUrl || DEFAULT_PROVIDERS.openai.baseUrl),
    },
  };
}

function ensureImageModels(raw?: unknown): ImageModelConfig[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_IMAGE_MODELS;

  const normalized = raw
    .map((item) => normalizeImageModelConfig((item || {}) as Partial<ImageModelConfig>))
    .filter((item, index, list) => item.id.length > 0 && list.findIndex((candidate) => candidate.id === item.id) === index);

  return normalized.length > 0 ? normalized : DEFAULT_IMAGE_MODELS;
}

function ensureTextModels(raw?: unknown): TextModelConfig[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_TEXT_MODELS;

  const normalized = raw
    .map((item) => normalizeTextModelConfig((item || {}) as Partial<TextModelConfig>))
    .filter((item): item is TextModelConfig => Boolean(item))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);

  return normalized.length > 0 ? normalized : DEFAULT_TEXT_MODELS;
}

function ensureDefaults(raw: Partial<DefaultModels> | undefined, imageModels: ImageModelConfig[], textModels: TextModelConfig[]): DefaultModels {
  const firstImageModelId = imageModels[0]?.id || DEFAULT_DEFAULTS.textToImage;
  const firstTextModelId = textModels[0]?.id || DEFAULT_DEFAULTS.reversePrompt;
  const next = { ...DEFAULT_DEFAULTS, ...raw };

  if (!imageModels.some((model) => model.id === next.textToImage)) next.textToImage = firstImageModelId;
  if (!imageModels.some((model) => model.id === next.imageToImage)) next.imageToImage = firstImageModelId;
  if (!textModels.some((model) => model.id === next.reversePrompt)) next.reversePrompt = firstTextModelId;
  if (!textModels.some((model) => model.id === next.agent)) next.agent = firstTextModelId;
  if (!textModels.some((model) => model.id === next.promptOptimize)) next.promptOptimize = firstTextModelId;
  if (!textModels.some((model) => model.id === next.imageDescribe)) next.imageDescribe = firstTextModelId;

  return next;
}

function getInitialRegistry(): NovaModelRegistry {
  return {
    providers: DEFAULT_PROVIDERS,
    imageModels: DEFAULT_IMAGE_MODELS,
    textModels: DEFAULT_TEXT_MODELS,
    defaults: DEFAULT_DEFAULTS,
  };
}

export function loadRegistry(): NovaModelRegistry {
  if (typeof window === 'undefined') {
    return getInitialRegistry();
  }

  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (!raw) {
      const initial = getInitialRegistry();
      saveRegistry(initial);
      return initial;
    }

    const parsed = JSON.parse(raw) as Partial<NovaModelRegistry>;
    const providers = ensureProviders(parsed.providers);
    const imageModels = ensureImageModels(parsed.imageModels);
    const textModels = ensureTextModels(parsed.textModels);
    const defaults = ensureDefaults(parsed.defaults, imageModels, textModels);
    return { providers, imageModels, textModels, defaults };
  } catch {
    const initial = getInitialRegistry();
    saveRegistry(initial);
    return initial;
  }
}

export function saveRegistry(registry: NovaModelRegistry): void {
  if (typeof window === 'undefined') return;

  const imageModels = ensureImageModels(registry.imageModels);
  const textModels = ensureTextModels(registry.textModels);
  const normalized: NovaModelRegistry = {
    providers: ensureProviders(registry.providers),
    imageModels,
    textModels,
    defaults: ensureDefaults(registry.defaults, imageModels, textModels),
  };

  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage errors
  }
}

export function getProviderSettings(registry: NovaModelRegistry, protocol: ProviderProtocol): ProviderSettings {
  return registry.providers[protocol];
}

export function getImageModelById(registry: NovaModelRegistry, id: string): ImageModelConfig | undefined {
  return registry.imageModels.find((model) => model.id === id);
}

export function getTextModelById(registry: NovaModelRegistry, id: string): TextModelConfig | undefined {
  return registry.textModels.find((model) => model.id === id);
}

export function getDefaultImageModel(
  registry: NovaModelRegistry,
  task: keyof Pick<DefaultModels, 'textToImage' | 'imageToImage'>,
): ImageModelConfig | undefined {
  return getImageModelById(registry, registry.defaults[task]);
}

export function getDefaultTextModel(
  registry: NovaModelRegistry,
  task: keyof Pick<DefaultModels, 'reversePrompt' | 'agent' | 'promptOptimize' | 'imageDescribe'>,
): TextModelConfig | undefined {
  return getTextModelById(registry, registry.defaults[task]);
}

export function getProviderForImageModel(
  registry: NovaModelRegistry,
  modelId: string,
): { provider: ProviderSettings; model: ImageModelConfig } | undefined {
  const model = getImageModelById(registry, modelId);
  if (!model) return undefined;
  return { provider: getProviderSettings(registry, model.protocol), model };
}

export function getProviderForTextModel(
  registry: NovaModelRegistry,
  modelId: string,
): { provider: ProviderSettings; model: TextModelConfig } | undefined {
  const model = getTextModelById(registry, modelId);
  if (!model) return undefined;
  return { provider: getProviderSettings(registry, model.protocol), model };
}

export function getBuiltinImagePreset(presetId: BuiltinImagePresetId): BuiltinImagePreset {
  return BUILTIN_IMAGE_PRESETS[presetId];
}

export function getImageModelOutputSizes(model: ImageModelConfig): ImageOutputSize[] {
  switch (model.maxOutputSize) {
    case '4K':
      return model.builtinPreset === 'gemini-3.1-flash-image-preview'
        ? ['512', '1K', '2K', '4K']
        : ['1K', '2K', '4K'];
    case '2K':
      return model.builtinPreset === 'gemini-3.1-flash-image-preview'
        ? ['512', '1K', '2K']
        : ['1K', '2K'];
    case '512':
      return ['512'];
    case '1K':
    default:
      return model.builtinPreset === 'gemini-3.1-flash-image-preview'
        ? ['512', '1K']
        : ['1K'];
  }
}

export function generateModelId(prefix: string = 'model'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
