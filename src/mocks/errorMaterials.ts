/** Listed in Biology 101; only these detail reads deliberately fail. */
export const errorMaterials = [
  {
    failure: 'load',
    id: 'mock-material-load',
    kind: 'note',
    title: 'Material load error',
  },
  {
    failure: 'unreadable',
    id: 'mock-material-unreadable',
    kind: 'note',
    title: 'Unreadable material',
  },
  {
    failure: null,
    id: 'mock-material-diagram',
    kind: 'diagram',
    title: 'Broken diagram',
  },
] as const;
