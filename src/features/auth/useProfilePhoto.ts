import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { m } from '@/i18n';
import { PROFILE_PHOTO_ACCEPT, profilePhotoError } from './profile-photo';

/** A picked profile photo waiting for save: the photo editor's props, the
 * applied 512 px crop and its preview URL, validation error and the hidden
 * file input's props. Clerk stores the crop on save. */
export function useProfilePhoto() {
  const [picked, setPicked] = useState<File | null>(null);
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
      const chosen = event.target.files?.[0];
      event.target.value = '';
      if (!chosen) return;
      const problem = profilePhotoError(chosen);
      if (problem) {
        setError(
          problem === 'size'
            ? m.onboarding_image_too_large()
            : m.onboarding_image_type()
        );
        return;
      }
      setError(null);
      setPicked(chosen);
    },
    ref: inputRef,
    type: 'file',
  } as const;

  const closeEditor = useCallback(() => setPicked(null), []);
  const applyCrop = useCallback((cropped: File) => {
    setFile(cropped);
    setPicked(null);
  }, []);

  return {
    clear,
    editor: { onApply: applyCrop, onClose: closeEditor, source: picked },
    error,
    file,
    inputProps,
    open: () => inputRef.current?.click(),
    preview,
  };
}
