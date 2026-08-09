import { describe, expect, it } from "vitest";
import {
  discoverAllShapefiles,
  multiShapefileVintage,
  selectShapefileLayers,
} from "../txgio/shapefile-discover";

const EAST =
  "C:/tmp/shp/stratmap25-landparcels_48201_harris_east_202508.shp";
const EAST_DBF =
  "C:/tmp/shp/stratmap25-landparcels_48201_harris_east_202508.dbf";
const EAST_PRJ =
  "C:/tmp/shp/stratmap25-landparcels_48201_harris_east_202508.prj";
const WEST =
  "C:/tmp/shp/stratmap25-landparcels_48201_harris_west_202508.shp";
const WEST_DBF =
  "C:/tmp/shp/stratmap25-landparcels_48201_harris_west_202508.dbf";
const WEST_PRJ =
  "C:/tmp/shp/stratmap25-landparcels_48201_harris_west_202508.prj";
const HAYS = "C:/tmp/shp/stratmap25-landparcels_48209_hays_202503.shp";
const HAYS_DBF = "C:/tmp/shp/stratmap25-landparcels_48209_hays_202503.dbf";

describe("discoverAllShapefiles", () => {
  it("returns every .shp with its .dbf/.prj, sorted east before west", () => {
    // Deliberately unordered input — west first — to prove sort.
    const layers = discoverAllShapefiles([
      WEST_PRJ,
      WEST_DBF,
      WEST,
      EAST_PRJ,
      EAST_DBF,
      EAST,
    ]);
    expect(layers).toHaveLength(2);
    expect(layers[0]!.shpFile).toBe(EAST);
    expect(layers[1]!.shpFile).toBe(WEST);
    expect(layers[0]!.dbfFile).toBe(EAST_DBF);
    expect(layers[0]!.prjFile).toBe(EAST_PRJ);
  });

  it("throws when a .shp has no sibling .dbf", () => {
    expect(() => discoverAllShapefiles([EAST])).toThrow(/no \.dbf next to/);
  });
});

describe("selectShapefileLayers — fail closed on N>1 without flag", () => {
  it("accepts a single shapefile without --multi-shp", () => {
    const { layers } = selectShapefileLayers([HAYS, HAYS_DBF], undefined);
    expect(layers).toHaveLength(1);
    expect(layers[0]!.shpFile).toBe(HAYS);
  });

  it("FAILS CLOSED on Harris-shaped archive without --multi-shp=concat", () => {
    expect(() =>
      selectShapefileLayers(
        [EAST, EAST_DBF, WEST, WEST_DBF],
        undefined,
      ),
    ).toThrow(/archive contains 2 shapefiles/);
    expect(() =>
      selectShapefileLayers(
        [EAST, EAST_DBF, WEST, WEST_DBF],
        undefined,
      ),
    ).toThrow(/--multi-shp=concat/);
  });

  it("concatenates when --multi-shp=concat is given", () => {
    const { layers } = selectShapefileLayers(
      [EAST, EAST_DBF, WEST, WEST_DBF],
      "concat",
    );
    expect(layers).toHaveLength(2);
    expect(layers.map((l) => l.shpFile)).toEqual([EAST, WEST]);
  });

  it("fails when no .shp is present", () => {
    expect(() => selectShapefileLayers([HAYS_DBF], undefined)).toThrow(
      /no \.shp found/,
    );
  });
});

describe("multiShapefileVintage", () => {
  it("joins stems with + in discovery order", () => {
    const layers = discoverAllShapefiles([
      EAST,
      EAST_DBF,
      WEST,
      WEST_DBF,
    ]);
    expect(multiShapefileVintage(layers)).toBe(
      "stratmap25-landparcels_48201_harris_east_202508+stratmap25-landparcels_48201_harris_west_202508",
    );
  });
});
