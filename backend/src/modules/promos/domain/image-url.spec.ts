import { publicImageUrl } from './image-url';

describe('publicImageUrl', () => {
  it.each<[string | null | undefined, string | null | undefined, string | null]>([
    [
      'https://cdn.portcity.ua',
      'promos/2026/11/a.jpg',
      'https://cdn.portcity.ua/promos/2026/11/a.jpg',
    ],
    ['https://cdn.portcity.ua/', '/events/b.png', 'https://cdn.portcity.ua/events/b.png'],
    [
      'https://s3.example.com/bucket//',
      'events/постер 1.jpg',
      'https://s3.example.com/bucket/events/%D0%BF%D0%BE%D1%81%D1%82%D0%B5%D1%80%201.jpg',
    ],
    [undefined, 'promos/a.jpg', null],
    ['', 'promos/a.jpg', null],
    ['https://cdn.portcity.ua', null, null],
    ['https://cdn.portcity.ua', '  ', null],
    [
      undefined,
      'https://portcity.com.ua/wp-content/a.jpg',
      'https://portcity.com.ua/wp-content/a.jpg',
    ],
  ])('base %s + key %s -> %s', (base, key, expected) => {
    expect(publicImageUrl(base, key)).toBe(expected);
  });
});
