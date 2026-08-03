## Getting Started

### Code Changes

- run `pnpm run fmt` and `pnpm run fix` to fix according to biome rules

## Common Pitfalls

### Frontend

- DO NOT directly import from `api/gen/model`, instead re-export type in `api/types.ts`. The file allows for subtle changes such as new frontend only fields on top of the auto generated types. 
- Use destructuring for react hook form useForm, otherwise the proxy may not register that you are reading isValid, causing submitDisabled to be true despite no errors
- Normally we should use useFieldArray for array values, e.g. in TagSelect. However sometimes we don't want to display individual error fields for each rendered element if they are too clustered, like in tagSelect, so we use standard control and dedup and format the error correctly before passing to InputError
- Sometimes its ok to use arbitary values instead of canonical values for tailwind, e.g. w-[200px] instead of w-50, in order to prevent element size changing when switching themes.
- DO NOT use template strings NOR variables just to hold classNames for tailwind, use `cn()` to inject conditional themes
- DO NOT make an index file for UI components, it will lead to cyclical import erorr during vite build