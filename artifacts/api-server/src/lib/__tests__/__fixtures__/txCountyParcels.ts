/**
 * Real county-ArcGIS parcel payload fixtures for the Central TX parcels
 * provider unit tests (`brokerageTxParcels.test.ts`).
 *
 * Captured live 2026-07-13 from each county's public parcel service with
 * `f=geojson&inSR=4326&outSR=4326&outFields=*` (the same query
 * `brokerageTxParcels.ts` issues). Properties are verbatim upstream
 * attribute payloads; polygon rings are trimmed to their first real
 * coordinates (+closure) to keep the fixture small — geometry SHAPE is
 * not asserted by the tests, attribute normalization is.
 *
 * Do NOT hand-edit attribute keys: they are the contract the per-county
 * normalizers in `brokerageTxParcels.ts` are tested against.
 */

export const TX_COUNTY_PARCEL_FIXTURES = {
  "travis": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": {
          "type": "Polygon",
          "coordinates": [
            [
              [
                -97.73970894377344,
                30.2681204929648
              ],
              [
                -97.73983979272737,
                30.26815637928463
              ],
              [
                -97.7399805473694,
                30.26819498258906
              ],
              [
                -97.74010378212911,
                30.267853683579776
              ],
              [
                -97.73996144453793,
                30.267815048363794
              ],
              [
                -97.73970894377344,
                30.2681204929648
              ]
            ]
          ]
        },
        "properties": {
          "OBJECTID": 55539,
          "PROP_ID": 194502,
          "geo_id": "0206031702",
          "situs_num": "615",
          "situs_street": "SAN JACINTO",
          "situs_zip": "78701",
          "situs_address": "615 SAN JACINTO BLVD 78701",
          "sub_dec": "BLOCK 067 ORIGINAL CITY",
          "entities": "01,02,03,0A,2J,68,2U",
          "tcad_acres": 0.27090001,
          "legal_desc": "LOT 11-12 BLOCK 067 ORIGINAL CITY",
          "hyperlink": "https://stage.travis.prodigycad.com/property-detail/194502",
          "Shape.STArea()": 11624.973369284533,
          "Shape.STLength()": 438.4786624245835,
          "situs_street_prefx": null,
          "situs_street_suffix": "BLVD",
          "situs_city": null,
          "LOTS": null,
          "CENTROID_X": null,
          "CENTROID_Y": null
        }
      },
      {
        "type": "Feature",
        "geometry": {
          "type": "Polygon",
          "coordinates": [
            [
              [
                -97.74000070135659,
                30.267769087161696
              ],
              [
                -97.7401186439097,
                30.26780172793774
              ],
              [
                -97.74014676355617,
                30.267728037006457
              ],
              [
                -97.74007832882982,
                30.26771015084721
              ],
              [
                -97.74002953891805,
                30.2676981620256
              ],
              [
                -97.74000070135659,
                30.267769087161696
              ]
            ]
          ]
        },
        "properties": {
          "OBJECTID": 55602,
          "PROP_ID": 194501,
          "geo_id": "0206031701",
          "situs_num": "607",
          "situs_street": "SAN JACINTO",
          "situs_zip": "78701",
          "situs_address": "607 SAN JACINTO BLVD 78701",
          "sub_dec": "BLOCK 067 ORIGINAL CITY",
          "entities": "01,02,03,0A,2J,3J,68,2U",
          "tcad_acres": 0.0254,
          "legal_desc": "N 28FT OF W 39.5FT OF LOT 1 BLOCK 067 ORIGINAL CITY (TOTAL SQ FT 1106)",
          "hyperlink": "https://stage.travis.prodigycad.com/property-detail/194501",
          "Shape.STArea()": 1081.3728890623959,
          "Shape.STLength()": 133.23668420298554,
          "situs_street_prefx": null,
          "situs_street_suffix": "BLVD",
          "situs_city": null,
          "LOTS": null,
          "CENTROID_X": null,
          "CENTROID_Y": null
        }
      }
    ]
  },
  "williamson": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": {
          "type": "Polygon",
          "coordinates": [
            [
              [
                -97.67979968847828,
                30.50774973438896
              ],
              [
                -97.67980708349322,
                30.50777208793084
              ],
              [
                -97.67997109946008,
                30.50772789374157
              ],
              [
                -97.68014065553498,
                30.507682177801428
              ],
              [
                -97.68017110357232,
                30.50767397712618
              ],
              [
                -97.67979968847828,
                30.50774973438896
              ]
            ]
          ]
        },
        "properties": {
          "QuickRefID": "R451908",
          "PropertyNumber": "R-16-5120-0007-0000",
          "LegalLocationCode": "S4493",
          "LegalLocationDesc": "S4493 - Round Rock City Of",
          "AbstractBlock": null,
          "SubLotRange": null,
          "SubSection": null,
          "TaxingUnitList": "CAD,CRR,GWI,J01,RFM,SRR,W09",
          "MapNumber": "3-5927",
          "PrimaryOwner": "1",
          "AddressChgReasonDesc": "Owner Requested Change",
          "ExemptionList": null,
          "MailingAddress": "c/o STATE & LOCAL TAX DEPT\nPO BOX 139100\nDALLAS, TX 75313-9100",
          "NameFirst": null,
          "NameMiddle": null,
          "NameLast": "ONCOR ELECTRIC DELIVERY COMPANY",
          "NameTitleKey": null,
          "NameSuffixKey": null,
          "FullName": "ONCOR ELECTRIC DELIVERY COMPANY",
          "IsSecured": "0",
          "OBJECTID": 8273,
          "PARCELID": "R451908",
          "BUILDING": null,
          "UNIT": null,
          "STATEDAREA": "0.025",
          "LGLSTARTDT": null,
          "CVTTXCD": "CAD,CRR,GWI,J01,RFM,SRR,W09",
          "CVTTXDSCRP": null,
          "SCHLTXCD": "SRR",
          "SCHLDSCRP": null,
          "USECD": "L",
          "USEDSCRP": "Land",
          "NGHBRHDCD": "R20",
          "CLASSCD": null,
          "CLASSDSCRP": null,
          "CNVYNAME": "S4493 - Round Rock City Of",
          "OWNERNME1": "ONCOR ELECTRIC DELIVERY COMPANY",
          "OWNERNME2": null,
          "PSTLCITY": "DALLAS",
          "PSTLSTATE": "TX",
          "PSTLZIP5": "75313",
          "PSTLZIP4": null,
          "FLOORCOUNT": null,
          "BLDGAREA": null,
          "RESFLRAREA": null,
          "RESYRBLT": null,
          "RESSTRTYP": null,
          "STRCLASS": null,
          "CLASSMOD": null,
          "LNDVALUE": 0,
          "PRVASSDVAL": 57630,
          "CNTASSDVAL": 0,
          "ASSDPCNTCG": null,
          "PRVTXBLVAL": 57630,
          "CNTTXBLVAL": 0,
          "PRVWNTTXOD": null,
          "PRVSMRTXOD": null,
          "CNTWNTTXOD": null,
          "CNTSMRTXOD": null,
          "TOTCNTTXOD": null,
          "TXODYRCHG": null,
          "WATERSERV": null,
          "SEWERSERV": null,
          "LASTUPDATE": 1783853767000,
          "GlobalID": "{DCD12F45-14D3-4654-8AB1-07C6A64E5403}",
          "StatedAc": null,
          "AssessedAc": "0.025",
          "PropertyID": "253773",
          "LegalDesc": "S4493 - Round Rock City Of, BLOCK 7, Lot ALLEY, ACRES 0.025",
          "SubUnit": null,
          "DataDate": "07/12/2026 06:51:55 AM",
          "TaxingUnitGroupDesc": "CAD,CRR,GWI,J01,RFM,SRR,W09",
          "SubBlock": "7",
          "SITEADDRESS": "BLAIR ST S, ROUND ROCK, TX  78664",
          "LOWPARCELID": null,
          "PRPRTYDSCRP": null,
          "PSTLADDRESS": "c/o STATE & LOCAL TAX DEPT PO BOX 139100 ",
          "ASSDVALYRCG": null,
          "TXBLVALYRCHG": null,
          "TXBLPCNTCHG": null,
          "TOTPRVTXTOD": null,
          "TXODPCNTCHG": null,
          "Tax_Year": "2026",
          "PropertyAddress": "BLAIR ST S, ROUND ROCK, TX  78664",
          "Acres": "0.025",
          "PropertyTypeKey": "RP",
          "PropertyTypeDesc": "Land",
          "PropertyTypeCode": "L",
          "DateCreated": "08/19/2004 10:34:51 AM",
          "DateLastChanged": "04/14/2026 11:00:49 PM",
          "RoutingNumber": null,
          "SchoolTaxingUnits": "SRR",
          "TaxingUnitGroupCode": "TUG13",
          "TaxingUnitGroupID": "407305",
          "NeighborhoodID": "400933",
          "NeighborhoodCode": "R20",
          "NeighborhoodDesc": "R20 - East Round Rock Vacant",
          "PropertyFlags": "2013R1OLNC,2014R1OLNC,2015R1OLNC,2016INQ2,2016R1OLNC,2017INQ3,2017R1OLNC,2018INQ2,2018R1OLNC,2019INQ2,2019R1OLNC,2020INQ1,2020R1OLNC,2021R1OLNC,2022R1OLNC,2023R1OLNC,2024R1OLNC,2026R1OLNC,26NOCOMPNOT,REXT13",
          "TotalAgUseValue": 0,
          "TotalAssessedValue": 57630,
          "TotalImpMktValue": 0,
          "TotalLandMktValue": 57630,
          "TotalPropMktValue": 57630,
          "TotalSqFtLivingArea": null,
          "MHModel": null,
          "MHSpace": null,
          "MHTitle": null,
          "SubLot": "ALLEY",
          "PropertyLegalType": "S",
          "Tract": null,
          "Serial": null,
          "Label": null,
          "HUDNumber": null,
          "HomeID": null,
          "MHMake": null,
          "MHMakeDesc": null,
          "PropertyLegalLocID": "402838",
          "SitusAddress": "BLAIR ST S, ROUND ROCK, TX  78664",
          "SStreetNumber": null,
          "SUnitTypeKey": null,
          "SUnitNumber": null,
          "SStreetDirectional": null,
          "SStreetName": "BLAIR",
          "SStreetSuffix": "ST",
          "Scity": "ROUND ROCK",
          "SStreetSuffixDirectional": "S",
          "Szip": "78664",
          "Sstate": "TX",
          "DBA": null,
          "CondoBuilding": null,
          "CondoPercentage": null,
          "CondoUnit": null,
          "SquareFeet": null,
          "NonStandardAddress": "0",
          "PartyID": "7166",
          "Mailing1": "c/o STATE & LOCAL TAX DEPT",
          "mailing2": "PO BOX 139100",
          "mailing3": null,
          "Mcity": "DALLAS",
          "IsUndeliverable": "0",
          "Mstate": "TX",
          "mStreetDirectional": null,
          "Mstreetname": null,
          "MStreetNumber": null,
          "MStreetSuffix": null,
          "MStreetSuffixDirectional": null,
          "Munittypekey": null,
          "Mzip": "75313-9100",
          "TxO_HSCapAdj": "0",
          "SHAPE.STArea()": 1076.2217971198086,
          "SHAPE.STLength()": 257.9171383700031,
          "CamaID": "SRR86922",
          "Type": 7,
          "InstrumentNumber": null
        }
      },
      {
        "type": "Feature",
        "geometry": {
          "type": "Polygon",
          "coordinates": [
            [
              [
                -97.6766469895625,
                30.505412170279016
              ],
              [
                -97.67645225901077,
                30.504866504718155
              ],
              [
                -97.67707830223196,
                30.504667626361872
              ],
              [
                -97.67686818151931,
                30.504063986819016
              ],
              [
                -97.67649585817163,
                30.50414870302919
              ],
              [
                -97.6766469895625,
                30.505412170279016
              ]
            ]
          ]
        },
        "properties": {
          "QuickRefID": "R055955",
          "PropertyNumber": "R-16-0298-0000-0038",
          "LegalLocationCode": "AW0298",
          "LegalLocationDesc": "AW0298 - Harris, W. Sur.",
          "AbstractBlock": null,
          "SubLotRange": null,
          "SubSection": null,
          "TaxingUnitList": "CAD,CRR,GWI,J01,RFM,SRR,W09",
          "MapNumber": "3-5927,(3-6018)",
          "PrimaryOwner": "1",
          "AddressChgReasonDesc": "New Address Record",
          "ExemptionList": null,
          "MailingAddress": "C/O FACILITY 1 LLC\n495 BROADWAY \n#FL 7\nNEW YORK, NY 10012",
          "NameFirst": null,
          "NameMiddle": null,
          "NameLast": "ROUND ROCK LAND LLC",
          "NameTitleKey": null,
          "NameSuffixKey": null,
          "FullName": "ROUND ROCK LAND LLC",
          "IsSecured": "0",
          "OBJECTID": 13784,
          "PARCELID": "R055955",
          "BUILDING": null,
          "UNIT": null,
          "STATEDAREA": "6.0204",
          "LGLSTARTDT": null,
          "CVTTXCD": "CAD,CRR,GWI,J01,RFM,SRR,W09",
          "CVTTXDSCRP": null,
          "SCHLTXCD": "SRR",
          "SCHLDSCRP": null,
          "USECD": "LTR",
          "USEDSCRP": "Land - Transitional",
          "NGHBRHDCD": "R20QN",
          "CLASSCD": null,
          "CLASSDSCRP": null,
          "CNVYNAME": "AW0298 - Harris, W. Sur.",
          "OWNERNME1": "ROUND ROCK LAND LLC",
          "OWNERNME2": null,
          "PSTLCITY": "NEW YORK",
          "PSTLSTATE": "NY",
          "PSTLZIP5": "10012",
          "PSTLZIP4": null,
          "FLOORCOUNT": null,
          "BLDGAREA": null,
          "RESFLRAREA": null,
          "RESYRBLT": null,
          "RESSTRTYP": null,
          "STRCLASS": null,
          "CLASSMOD": null,
          "LNDVALUE": 0,
          "PRVASSDVAL": 554107,
          "CNTASSDVAL": 0,
          "ASSDPCNTCG": null,
          "PRVTXBLVAL": 554107,
          "CNTTXBLVAL": 0,
          "PRVWNTTXOD": null,
          "PRVSMRTXOD": null,
          "CNTWNTTXOD": null,
          "CNTSMRTXOD": null,
          "TOTCNTTXOD": null,
          "TXODYRCHG": null,
          "WATERSERV": null,
          "SEWERSERV": null,
          "LASTUPDATE": 1783853767000,
          "GlobalID": "{D8E55237-F45D-4CD7-8FE6-0BC619B02B67}",
          "StatedAc": null,
          "AssessedAc": "6.0574",
          "PropertyID": "111398",
          "LegalDesc": "AW0298 AW0298 - Harris, W. Sur., ACRES 6.0574",
          "SubUnit": null,
          "DataDate": "07/12/2026 06:51:55 AM",
          "TaxingUnitGroupDesc": "CAD,CRR,GWI,J01,RFM,SRR,W09",
          "SubBlock": null,
          "SITEADDRESS": "599 S MAYS ST, ROUND ROCK, TX  78664",
          "LOWPARCELID": null,
          "PRPRTYDSCRP": null,
          "PSTLADDRESS": "C/O FACILITY 1 LLC 495 BROADWAY  FL 7",
          "ASSDVALYRCG": null,
          "TXBLVALYRCHG": null,
          "TXBLPCNTCHG": null,
          "TOTPRVTXTOD": null,
          "TXODPCNTCHG": null,
          "Tax_Year": "2026",
          "PropertyAddress": "599 S MAYS ST, ROUND ROCK, TX  78664",
          "Acres": "6.0574",
          "PropertyTypeKey": "RP",
          "PropertyTypeDesc": "Land - Transitional",
          "PropertyTypeCode": "LTR",
          "DateCreated": "10/30/2003 07:44:39 PM",
          "DateLastChanged": "04/14/2026 09:04:29 PM",
          "RoutingNumber": null,
          "SchoolTaxingUnits": "SRR",
          "TaxingUnitGroupCode": "TUG13",
          "TaxingUnitGroupID": "407305",
          "NeighborhoodID": "400997",
          "NeighborhoodCode": "R20QN",
          "NeighborhoodDesc": "R20QN - Rr East Nom-imp",
          "PropertyFlags": "2013R1OLNC,2014R1OLNC,2015R1OLNC,2016HB3630,2016INQ1,2016R1OLNC,2017HB3630,2017INQ3,2017R1OLNC,2018INQ3,2018R1OLP,2019INQ2,2019R1OLNC,2020INQ1,2020R1OLNC,2021R1OLNC,2022R1OLNC,2023R1OLNC,2024R1OLNC,2025R1OLNC,2026R1OLNC,25NOCOMPNOT,26NOCOMPNOT",
          "TotalAgUseValue": 0,
          "TotalAssessedValue": 554107,
          "TotalImpMktValue": 0,
          "TotalLandMktValue": 554107,
          "TotalPropMktValue": 554107,
          "TotalSqFtLivingArea": null,
          "MHModel": null,
          "MHSpace": null,
          "MHTitle": null,
          "SubLot": null,
          "PropertyLegalType": "A",
          "Tract": null,
          "Serial": null,
          "Label": null,
          "HUDNumber": null,
          "HomeID": null,
          "MHMake": null,
          "MHMakeDesc": null,
          "PropertyLegalLocID": "398742",
          "SitusAddress": "599 S MAYS ST, ROUND ROCK, TX  78664",
          "SStreetNumber": "599",
          "SUnitTypeKey": null,
          "SUnitNumber": null,
          "SStreetDirectional": "S",
          "SStreetName": "MAYS",
          "SStreetSuffix": "ST",
          "Scity": "ROUND ROCK",
          "SStreetSuffixDirectional": null,
          "Szip": "78664",
          "Sstate": "TX",
          "DBA": null,
          "CondoBuilding": null,
          "CondoPercentage": "0",
          "CondoUnit": null,
          "SquareFeet": null,
          "NonStandardAddress": "0",
          "PartyID": "712903",
          "Mailing1": "C/O FACILITY 1 LLC",
          "mailing2": "495 BROADWAY",
          "mailing3": "FL 7",
          "Mcity": "NEW YORK",
          "IsUndeliverable": "0",
          "Mstate": "NY",
          "mStreetDirectional": null,
          "Mstreetname": "BROADWAY",
          "MStreetNumber": "495",
          "MStreetSuffix": null,
          "MStreetSuffixDirectional": null,
          "Munittypekey": "FL",
          "Mzip": "10012",
          "TxO_HSCapAdj": "0",
          "SHAPE.STArea()": 250630.81677425615,
          "SHAPE.STLength()": 2449.6757607998693,
          "CamaID": "SRR185446",
          "Type": 7,
          "InstrumentNumber": null
        }
      }
    ]
  },
  "bexar": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": {
          "type": "Polygon",
          "coordinates": [
            [
              [
                -98.49240592710298,
                29.4237612257585
              ],
              [
                -98.49225372269416,
                29.423742714829203
              ],
              [
                -98.49221623163068,
                29.423998453807002
              ],
              [
                -98.49235136370002,
                29.424026883053912
              ],
              [
                -98.49236942407043,
                29.423938954840665
              ],
              [
                -98.49240592710298,
                29.4237612257585
              ]
            ]
          ]
        },
        "properties": {
          "OBJECTID": 83624,
          "PropID": 101650,
          "Situs": "510 W MARKET ST ",
          "Owner": "CITY OF SAN ANTONIO",
          "AddrLn1": "NULL",
          "AddrLn2": "PO BOX 839966",
          "AddrLn3": "NULL",
          "AddrCity": "SAN ANTONIO",
          "AddrSt": "TX",
          "Country": "US   ",
          "Zip": "78283",
          "Zip4": "3966",
          "DBA": "NULL",
          "AcctNumb": "00146-000-0011",
          "LglDesc": "NCB   146  BLK      LOT S 102.7 FT OF 1, PT OF 1-3 E 73 FT OF 5 ",
          "LandVal": 0,
          "ImprVal": 0,
          "TotVal": 0,
          "Nbhd": "10011",
          "GBA": "NULL",
          "TOT_GBA": "NULL",
          "YrBlt": "NULL",
          "Stories": null,
          "NumRooms": "NULL",
          "Houses": "0",
          "Detached": "0",
          "State_cd": "C1",
          "LglAcres": 0,
          "Acres": 0.0764,
          "TaxUnits": "CAD, 06, 08, 09, 10, 11, 21, 57, SA009, DPID",
          "Exempts": "EX-XV",
          "IS_UDI": null,
          "UDIPARNT": null,
          "Roll": "C         ",
          "SWP": "EXPUB     ",
          "PropUse": "5000",
          "Shape.STArea()": 4460.171684543305,
          "Shape.STLength()": 285.05154529103646
        }
      },
      {
        "type": "Feature",
        "geometry": {
          "type": "Polygon",
          "coordinates": [
            [
              [
                -98.49240592710298,
                29.4237612257585
              ],
              [
                -98.49236942407043,
                29.423938954840665
              ],
              [
                -98.49235136370002,
                29.424026883053912
              ],
              [
                -98.4924814714724,
                29.42405424549411
              ],
              [
                -98.49250245866205,
                29.42395637049413
              ],
              [
                -98.49240592710298,
                29.4237612257585
              ]
            ]
          ]
        },
        "properties": {
          "OBJECTID": 83633,
          "PropID": 101649,
          "Situs": "510 W MARKET ST ",
          "Owner": "CITY OF SAN ANTONIO",
          "AddrLn1": "NULL",
          "AddrLn2": "PO BOX 839966",
          "AddrLn3": "NULL",
          "AddrCity": "SAN ANTONIO",
          "AddrSt": "TX",
          "Country": "US   ",
          "Zip": "78283",
          "Zip4": "3966",
          "DBA": "NULL",
          "AcctNumb": "00146-000-0010",
          "LglDesc": "NCB   146  BLK      LOT 11/2   ",
          "LandVal": 0,
          "ImprVal": 0,
          "TotVal": 0,
          "Nbhd": "10011",
          "GBA": "NULL",
          "TOT_GBA": "NULL",
          "YrBlt": "NULL",
          "Stories": null,
          "NumRooms": "NULL",
          "Houses": "0",
          "Detached": "0",
          "State_cd": "C1",
          "LglAcres": 0,
          "Acres": 0.0413,
          "TaxUnits": "CAD, 06, 08, 09, 10, 11, 21, 57, SA009, DPID",
          "Exempts": "EX-XV",
          "IS_UDI": null,
          "UDIPARNT": null,
          "Roll": "C         ",
          "SWP": "EXPUB     ",
          "PropUse": "5000",
          "Shape.STArea()": 4302.379914785462,
          "Shape.STLength()": 286.4388763859466
        }
      }
    ]
  },
  "bastrop": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": {
          "type": "Polygon",
          "coordinates": [
            [
              [
                -97.31584733630086,
                30.10610077915788
              ],
              [
                -97.31574385892213,
                30.106102331222
              ],
              [
                -97.31571219745032,
                30.106102806153267
              ],
              [
                -97.31571377408854,
                30.10625020503894
              ],
              [
                -97.31574413173153,
                30.106249672274764
              ],
              [
                -97.31584733630086,
                30.10610077915788
              ]
            ]
          ]
        },
        "properties": {
          "objectid": 188,
          "prop_id_text": "8741600",
          "created_date": null,
          "last_edited_date": null,
          "prop_id": 8741600,
          "owner_tax_yr": 2026,
          "file_as_name": "BARE MIN LAND LLC",
          "legal_acreage": 0.163,
          "hood_cd": "NBHD0313",
          "school": null,
          "city": null,
          "county": null,
          "next_appraisal_dt": null,
          "legal_desc": "JEFFERSON VILLA LOT 1, ACRES .163",
          "legal_desc2": null,
          "legal_desc3": null,
          "tract_or_lot": "1",
          "abs_subdv_cd": "S6371 - Jefferson Vi",
          "land_val": 71003,
          "imprv_val": 0,
          "market": 71003,
          "block": "1",
          "map_id": null,
          "geo_id": null,
          "situs_num": null,
          "situs_street_prefx": null,
          "situs_street": null,
          "situs_street_sufix": null,
          "situs_city": null,
          "situs_state": "TX",
          "situs_zip": null,
          "addr_line1": "557 THOUSAND OAK DR",
          "addr_line2": null,
          "addr_line3": null,
          "addr_city": "CEDAR CREEK",
          "addr_state": "TX",
          "zip": "78612",
          "deed_seq": null,
          "deed_date": null,
          "volume": null,
          "page": null,
          "number": null,
          "globalid": "{4692A8D8-25B1-43AA-B2C4-5E8559623CC1}",
          "firearm_discharge_prohibited": null
        }
      },
      {
        "type": "Feature",
        "geometry": {
          "type": "Polygon",
          "coordinates": [
            [
              [
                -97.31977828764295,
                30.107642765264824
              ],
              [
                -97.31990585998474,
                30.108021241903806
              ],
              [
                -97.32055314008272,
                30.107981418330116
              ],
              [
                -97.3205267577476,
                30.107931832840848
              ],
              [
                -97.32047486274962,
                30.10779352747508
              ],
              [
                -97.31977828764295,
                30.107642765264824
              ]
            ]
          ]
        },
        "properties": {
          "objectid": 15845,
          "prop_id_text": "8702337",
          "created_date": null,
          "last_edited_date": null,
          "prop_id": 8702337,
          "owner_tax_yr": 2026,
          "file_as_name": "BAHAM INTEREST LIMITED PARTNERSHIP",
          "legal_acreage": 0.54,
          "hood_cd": "NBHD0313",
          "school": null,
          "city": null,
          "county": null,
          "next_appraisal_dt": null,
          "legal_desc": "Baham Interests Subdivision LOT 1, .5400 ACRES",
          "legal_desc2": null,
          "legal_desc3": null,
          "tract_or_lot": null,
          "abs_subdv_cd": "S5110 - Baham Intere",
          "land_val": 535135,
          "imprv_val": 94787,
          "market": 629922,
          "block": null,
          "map_id": null,
          "geo_id": "R55931",
          "situs_num": "704",
          "situs_street_prefx": null,
          "situs_street": "MAIN STREET, SUITE 101",
          "situs_street_sufix": null,
          "situs_city": null,
          "situs_state": "TX",
          "situs_zip": null,
          "addr_line1": "PO BOX 709",
          "addr_line2": null,
          "addr_line3": null,
          "addr_city": "BASTROP",
          "addr_state": "TX",
          "zip": "78602-0709",
          "deed_seq": 1,
          "deed_date": "05/03/2013",
          "volume": "2230",
          "page": "284",
          "number": "0",
          "globalid": "{3CFA714D-A39A-4E39-B147-577583953745}",
          "firearm_discharge_prohibited": null
        }
      }
    ]
  },
  "caldwell": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": {
          "type": "Polygon",
          "coordinates": [
            [
              [
                -97.6710795367225,
                29.8870005299912
              ],
              [
                -97.6716981889979,
                29.8868994139315
              ],
              [
                -97.6717850228973,
                29.8873270535295
              ],
              [
                -97.6719330029306,
                29.8880558135005
              ],
              [
                -97.6711250171669,
                29.8881966862642
              ],
              [
                -97.6710795367225,
                29.8870005299912
              ]
            ]
          ]
        },
        "properties": {
          "OBJECTID": 4411,
          "PARCELS_": 5381,
          "PARCELS_ID": 24655,
          "ADJUST": "PHOTO",
          "OLDPROPID": "R17025",
          "Prop_ID": 17025,
          "Shape__Area": 97047.955078125,
          "Shape__Length": 1323.2898107315098
        }
      },
      {
        "type": "Feature",
        "geometry": {
          "type": "Polygon",
          "coordinates": [
            [
              [
                -97.6746220149972,
                29.8875585710992
              ],
              [
                -97.6741853566818,
                29.8876258252997
              ],
              [
                -97.6740693307474,
                29.8871191080258
              ],
              [
                -97.6745103150646,
                29.8870473272669
              ],
              [
                -97.674549015284,
                29.8872262929672
              ],
              [
                -97.6746220149972,
                29.8875585710992
              ]
            ]
          ]
        },
        "properties": {
          "OBJECTID": 4501,
          "PARCELS_": 5476,
          "PARCELS_ID": 24739,
          "ADJUST": "PHOTO",
          "OLDPROPID": "R17915",
          "Prop_ID": 17915,
          "Shape__Area": 26646.546875,
          "Shape__Length": 659.9303533345962
        }
      }
    ]
  }
} as const;
