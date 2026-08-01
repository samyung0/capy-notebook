## Getting Started

### Code Changes

- run `pnpm run fmt` and `pnpm run fix` to fix according to biome rules

## Common Pitfalls

### Frontend

- Use destructuring for react hook form useForm, otherwise the proxy may not register that you are reading isValid, causing submitDisabled to be true despite no errors
- Normally we should use useFieldArray for array values, e.g. in TagSelect. However sometimes we don't want to display individual error fields for each rendered element if they are too clustered, like in tagSelect, so we use standard control and dedup and format the error correctly before passing to InputError
- Sometimes its ok to use arbitary values instead of canonical values for tailwind, e.g. w-[200px] instead of w-50, in order to prevent element size changing when switching themes.