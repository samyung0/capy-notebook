import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { m } from '@/i18n';
import { PROFILE_PHOTO_ACCEPT, profilePhotoError } from './profile-photo';

/** A picked profile photo waiting for save: its preview URL, validation error
 * and the hidden file input's props. Clerk stores the photo on save. */
export function useProfilePhoto() {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const preview = useMemo(
    () => (file ? URL.createObjectURL(file) : undefined),
    [file]
  );
  useEffect(() => {
    if (preview) return () => URL.revokeObjectURL(preview);
  }, [preview]);

  const clear = () => {
    setFile(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  };
  const inputProps = {
    accept: PROFILE_PHOTO_ACCEPT,
    hidden: true,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const picked = event.target.files?.[0];
      event.target.value = '';
      if (!picked) return;
      const problem = profilePhotoError(picked);
      if (problem) {
        setError(
          problem === 'size'
            ? m.onboarding_image_too_large()
            : m.onboarding_image_type()
        );
        return;
      }
      setError(null);
      setFile(picked);
    },
    ref: inputRef,
    type: 'file',
  } as const;

  return {
    clear,
    error,
    file,
    inputProps,
    open: () => inputRef.current?.click(),
    preview,
  };
}
