/**
 * 윷 던지기 판정. 브라우저(윷 던지기 전용 모드)와 서버(온라인 게임)가 함께 쓴다.
 * DOM·Node 전용 API 를 쓰지 않는다.
 */
export const STICK_COUNT = 4;
/** 윷가락 한 개가 평평한 면(배)이 위로 올 확률 */
export const FLAT_PROBABILITY = 0.55;

export const TOSS_RESULTS = Object.freeze({
  DO: Object.freeze({ key: 'DO', name: '도', steps: 1, again: false }),
  GAE: Object.freeze({ key: 'GAE', name: '개', steps: 2, again: false }),
  GEOL: Object.freeze({ key: 'GEOL', name: '걸', steps: 3, again: false }),
  YUT: Object.freeze({ key: 'YUT', name: '윷', steps: 4, again: true }),
  MO: Object.freeze({ key: 'MO', name: '모', steps: 5, again: true }),
  BACKDO: Object.freeze({ key: 'BACKDO', name: '뒷도', steps: -1, again: false }),
});

/**
 * @param {boolean[]} flats 각 윷가락의 배(평평한 면)가 위인지. 길이 4. flats[0] 이 뒷도 표시 가락.
 * @param {boolean} backdoEnabled 뒷도(백도) 규칙 사용 여부
 */
export function judgeToss(flats, backdoEnabled) {
  const flatCount = flats.filter(Boolean).length;
  if (backdoEnabled && flatCount === 1 && flats[0]) {
    return TOSS_RESULTS.BACKDO;
  }
  switch (flatCount) {
    case 0:
      return TOSS_RESULTS.MO;
    case 1:
      return TOSS_RESULTS.DO;
    case 2:
      return TOSS_RESULTS.GAE;
    case 3:
      return TOSS_RESULTS.GEOL;
    default:
      return TOSS_RESULTS.YUT;
  }
}

export function tossSticks(random = Math.random) {
  return Array.from({ length: STICK_COUNT }, () => random() < FLAT_PROBABILITY);
}
