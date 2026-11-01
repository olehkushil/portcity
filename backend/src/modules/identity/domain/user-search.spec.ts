import { parseUserSearchQuery } from './user-search';

describe('parseUserSearchQuery', () => {
  it.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['   ', null],
    ['Oleh@Example.com', { email: 'oleh@example.com' }],
    ['+380501234567', { phoneExact: '+380501234567' }],
    ['050 123 45 67', { phoneExact: '+380501234567' }],
    ['380501234567', { phoneExact: '+380501234567' }],
    ['734211800', { phoneExact: '+380734211800', memberCode: '734211800' }],
    ['501234567', { phoneExact: '+380501234567', memberCode: '501234567' }],
    ['123456789', { memberCode: '123456789', digitFragment: '123456789' }],
    ['1234', { digitFragment: '1234' }],
    ['Олег', { name: 'Олег' }],
    ['  Демо  ', { name: 'Демо' }],
  ])('%p -> %p', (input, expected) => {
    expect(parseUserSearchQuery(input)).toEqual(expected);
  });

  it('truncates very long queries', () => {
    const terms = parseUserSearchQuery('a'.repeat(500));
    expect(terms?.name?.length).toBe(100);
  });
});
