import { z } from "zod";

/** Strict POST body for /place/buildable-envelope. Extra keys stay 400. */
export const POST_BODY = z
  .object({
    address: z.string().min(1).optional(),
    lat: z.number().finite().optional(),
    lng: z.number().finite().optional(),
    /** Skip the (slow, best-effort) OSM road fetch — labeling uses point/shape. */
    skipRoad: z.boolean().optional(),
    /** Clicked/resolved parcel node. Jurisdiction may use this when situs is city-less. */
    parcel_node_id: z.string().min(1).optional(),
  })
  .strict();
