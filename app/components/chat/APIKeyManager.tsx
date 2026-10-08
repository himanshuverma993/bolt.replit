import React, { useState } from 'react';
import { IconButton } from '~/components/ui/IconButton';
import type { ProviderInfo } from '~/types/model';

interface APIKeyManagerProps {
  provider: ProviderInfo;
  apiKey: string;
  setApiKey: (key: string) => void;
  getApiKeyLink?: string;
  labelForGetApiKey?: string;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export const APIKeyManager: React.FC<APIKeyManagerProps> = ({ provider, apiKey, setApiKey }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [tempKey, setTempKey] = useState(apiKey);

  const handleSave = () => {
    setApiKey(tempKey);
    setIsEditing(false);
  };

  const keyEditor = (optional: boolean) => (
    <>
      {!isEditing && (
        <div className="flex items-center mb-4">
          <span className="flex-1 text-xs text-bolt-elements-textPrimary mr-2">
            {apiKey
              ? '••••••••'
              : optional
                ? 'not set (works without a key)'
                : 'Not set (will still work if set in .env file)'}
          </span>
          <IconButton onClick={() => setIsEditing(true)} title="Edit API Key">
            <div className="i-ph:pencil-simple" />
          </IconButton>
        </div>
      )}

      {isEditing ? (
        <div className="flex items-center gap-3 mt-2">
          <input
            type="password"
            value={tempKey}
            placeholder={optional ? 'Optional key (UnoRouter / HuggingFace token…)' : 'Your API Key'}
            onChange={(e) => setTempKey(e.target.value)}
            className="flex-1 px-2 py-1 text-xs lg:text-sm rounded border border-bolt-elements-borderColor bg-bolt-elements-prompt-background text-bolt-elements-textPrimary focus:outline-none focus:ring-2 focus:ring-bolt-elements-focus"
          />
          <IconButton onClick={handleSave} title="Save API Key">
            <div className="i-ph:check" />
          </IconButton>
          <IconButton onClick={() => setIsEditing(false)} title="Cancel">
            <div className="i-ph:x" />
          </IconButton>
        </div>
      ) : (
        <>
          {provider?.getApiKeyLink && (
            <IconButton className="ml-auto" onClick={() => window.open(provider?.getApiKeyLink)} title="Edit API Key">
              <span className="mr-2 text-xs lg:text-sm">{provider?.labelForGetApiKey || 'Get API Key'}</span>
              <div className={provider?.icon || 'i-ph:key'} />
            </IconButton>
          )}
        </>
      )}
    </>
  );

  /*
   * Keyless providers (Cloudflare Workers AI, FreeLLMAPI) work without a key,
   * but many of their endpoints accept an optional one (router unified key,
   * UnoRouter or HuggingFace token). Show the explanation plus an optional
   * key editor instead of hiding key management entirely.
   */
  if (provider.requiresApiKey === false) {
    return (
      <div className="mt-2 mb-4 text-xs text-bolt-elements-textSecondary">
        <div>
          <span className="text-bolt-elements-textPrimary">{provider.name}:</span>{' '}
          {provider.noApiKeyNote || 'no API key needed.'}
        </div>
        <div className="mt-1">
          <span className="text-sm text-bolt-elements-textSecondary">Optional key:</span>
          {keyEditor(true)}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start sm:items-center mt-2 mb-2 flex-col sm:flex-row">
      <div>
        <span className="text-sm text-bolt-elements-textSecondary">{provider?.name} API Key:</span>
        {keyEditor(false)}
      </div>
    </div>
  );
};
