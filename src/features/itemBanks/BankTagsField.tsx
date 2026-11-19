import { z } from 'zod';
import {
  createItemBankQuestionBodyTagsItemMax,
  createItemBankQuestionBodyTagsMax,
} from '@/api/gen/validators';
import type { TagInput } from '@/api/types';
import { flattenTagErrors } from '@/components/ui/flattenTagErrors';
import { InputError, InputTitle } from '@/components/ui/Input';
import { TagSelect } from '@/components/ui/TagSelect';
import { m } from '@/i18n';

/** A bank question's free-text tags, as the bank endpoints take them. */
export const bankTagsSchema = z
  .array(
    z.object({
      id: z.string().optional(),
      value: z
        .string()
        .trim()
        .min(1)
        .max(createItemBankQuestionBodyTagsItemMax)
        .refine((value) => !value.includes(','), m.bank_tag_comma()),
    })
  )
  .max(createItemBankQuestionBodyTagsMax);

/** The Edit question dialog's Tags under Topic (Epo 2026-11-15, as Canvas's
 * "Tags and Metadata"), offering the bank's other tags as you type. */
export function BankTagsField({
  catalog,
  error,
  invalid,
  onChange,
  value,
}: {
  catalog: string[];
  error: unknown;
  invalid: boolean;
  onChange: (tags: TagInput[]) => void;
  value: TagInput[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <InputTitle
        count={{
          from: createItemBankQuestionBodyTagsMax - 1,
          max: createItemBankQuestionBodyTagsMax,
          value: value.length,
        }}
      >
        {m.common_tags()}
      </InputTitle>
      <TagSelect
        catalog={catalog.map((tag) => ({ id: tag, value: tag }))}
        invalid={invalid}
        max={createItemBankQuestionBodyTagsMax}
        maxLength={createItemBankQuestionBodyTagsItemMax}
        onChange={onChange}
        value={value}
      />
      {invalid && <InputError errors={flattenTagErrors(error)} />}
    </div>
  );
}
