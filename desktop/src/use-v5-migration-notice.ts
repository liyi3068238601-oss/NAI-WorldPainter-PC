import { useEffect, useState } from 'react';
import { isNAIV5Model } from './types';

export const V5_MIGRATION_NOTICE_KEY = 'langbai.notice.v5-model-migration.seen';
export const V5_MIGRATION_NOTICE_LEGACY_KEY = 'langbai.notice.v5-model-migration.v2';

// Assess restored settings once per profile. Deliberately choosing an older
// model after a V5 startup must not be mistaken for migrating an old profile.
export function useV5MigrationNotice(ready: boolean, model: string, captureMode = false) {
  const [dismissed, setDismissed] = useState(() => captureMode
    || localStorage.getItem(V5_MIGRATION_NOTICE_KEY) === 'seen'
    || localStorage.getItem(V5_MIGRATION_NOTICE_LEGACY_KEY) === 'dismissed');
  const shouldShow = ready && !dismissed && !isNAIV5Model(model);
  useEffect(() => {
    if (!ready || dismissed || captureMode) return;
    // A V5 profile is assessed too, so a later manual model choice stays quiet
    // after restart. For old profiles, mark on presentation to cover force-close.
    localStorage.setItem(V5_MIGRATION_NOTICE_KEY, 'seen');
    if (isNAIV5Model(model)) setDismissed(true);
  }, [ready, dismissed, captureMode, model]);
  const dismiss = () => {
    localStorage.setItem(V5_MIGRATION_NOTICE_KEY, 'seen');
    setDismissed(true);
  };
  return { shouldShow, dismiss };
}
