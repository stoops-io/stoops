/** Random display name generation for participants and rooms. */

const PLACES = [
  "bay", "cove", "glen", "moor", "fjord", "cape", "crag", "bluff", "cliff", "ridge",
  "peak", "mesa", "butte", "canyon", "gorge", "ravine", "gulch", "dell", "dune", "plain",
  "heath", "fell", "bog", "marsh", "pond", "lake", "tarn", "pool", "harbor", "haven",
  "inlet", "gulf", "sound", "strait", "channel", "delta", "lagoon", "atoll", "shoal", "shore",
  "coast", "isle", "forest", "grove", "copse", "glade", "meadow", "field", "valley", "hollow",
  "nook", "ford", "falls", "spring", "well", "crest", "knoll", "summit", "slope", "basin",
  "bank", "strand", "loch", "steppe", "tundra", "prairie", "savanna", "jungle", "desert",
  "highland", "estuary", "bight", "spit", "islet", "island", "tor", "vale", "brook", "creek",
  "river", "weir", "cascade", "scarp", "tower", "plateau", "upland", "lowland",
];

/** Generate a random room name like "Glen-4827". */
export function randomRoomName(): string {
  const place = PLACES[Math.floor(Math.random() * PLACES.length)];
  const digits = String(Math.floor(Math.random() * 9000) + 1000);
  return `${place[0].toUpperCase()}${place.slice(1)}-${digits}`;
}

const NAMES = [
  "ash", "kai", "sol", "pip", "kit", "zev", "bly", "rue", "dex", "nix",
  "wren", "gray", "clay", "reed", "roux", "roan", "jade", "max", "val", "xen",
  "zen", "pax", "jude", "finn", "sage", "remy", "nico", "noel", "lumi", "jules",
  "hero", "eden", "blake", "bram", "clem", "flint", "nox", "oak", "moss", "bryn",
  "lyra", "mars", "neve", "onyx", "sable", "thea", "koa", "ren", "ora", "lev",
  "tru", "vox", "quinn", "rowan", "avery", "cass", "greer", "holt", "arlo", "drew",
  "emery", "finley", "harley", "harper", "jamie", "vesper", "west", "wynne", "yael",
  "zion", "sawyer", "scout", "tatum", "toby", "toni", "riley", "reese", "morgan",
  "micah", "logan", "lane", "jordan", "perry", "piper", "erin", "dylan", "camden",
  "seren", "elio", "cael", "davi", "lyric", "kiran", "arrow", "riven", "cleo",
  "sora", "tae", "cade", "milo",
];

/** Generate a random display name like "Wren-4827". */
export function randomName(): string {
  const name = NAMES[Math.floor(Math.random() * NAMES.length)];
  const digits = String(Math.floor(Math.random() * 9000) + 1000);
  return `${name[0].toUpperCase()}${name.slice(1)}-${digits}`;
}
