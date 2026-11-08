// Live mainnet captures (2026-11-08, block 223566541), trimmed to the fields the yield reader uses.
// They live here, not in fixtures/, because they name mainnet protocol contracts (tokens, Rhea Lend), and
// fixtures/ holds testnet names only (fixtures.test.ts). No DAO or user account appears here.
export const MAINNET_ASSETS = [
  {
    "token_id": "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near",
    "supplied": {
      "shares": "187992374635730477430479",
      "balance": "246076540164028995868284"
    },
    "borrowed": {
      "shares": "207232542245945491471981",
      "balance": "284687556807064286159586"
    },
    "reserved": "100000560868811308829702",
    "last_update_timestamp": "1794112658321649970",
    "config": {
      "extra_decimals": 12,
      "can_deposit": true,
      "can_withdraw": true
    },
    "supply_apr": "0.088884090463092630465257669",
    "borrow_apr": "0.102438803213341602791623204",
    "farms": [
      {
        "farm_id": {
          "Supplied": "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near"
        },
        "rewards": {}
      },
      {
        "farm_id": {
          "Borrowed": "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near"
        },
        "rewards": {}
      }
    ]
  },
  {
    "token_id": "wrap.near",
    "supplied": {
      "shares": "3140553551017243824587327308789",
      "balance": "3319276591287534439944513051537"
    },
    "borrowed": {
      "shares": "482722784001066656183595314057",
      "balance": "586517138604515641383958159350"
    },
    "reserved": "14260110831671506280286104895",
    "last_update_timestamp": "1794112658322177847",
    "config": {
      "extra_decimals": 0,
      "can_deposit": true,
      "can_withdraw": true
    },
    "supply_apr": "0.003344609237591021379488624",
    "borrow_apr": "0.025237530542310287657515746",
    "farms": [
      {
        "farm_id": {
          "Supplied": "wrap.near"
        },
        "rewards": {}
      },
      {
        "farm_id": {
          "Borrowed": "wrap.near"
        },
        "rewards": {}
      }
    ]
  },
  {
    "token_id": "usdt.tether-token.near",
    "supplied": {
      "shares": "10907223474051298722395860",
      "balance": "12585742234584925427495423"
    },
    "borrowed": {
      "shares": "8451371552960813402693656",
      "balance": "10602648276184717943713303"
    },
    "reserved": "200005479467782202223635",
    "last_update_timestamp": "1794112658322467699",
    "config": {
      "extra_decimals": 12,
      "can_deposit": true,
      "can_withdraw": true
    },
    "supply_apr": "0.072776405032672913952379675",
    "borrow_apr": "0.115184439540239878870415838",
    "farms": [
      {
        "farm_id": {
          "TokenNetBalance": "usdt.tether-token.near"
        },
        "rewards": {}
      }
    ]
  },
  {
    "token_id": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "supplied": {
      "shares": "11066727781999251927021788",
      "balance": "12804268735502840958151089"
    },
    "borrowed": {
      "shares": "8704865272892967084677986",
      "balance": "10946840701009714704953809"
    },
    "reserved": "200002851391639234112802",
    "last_update_timestamp": "1794112658322118778",
    "config": {
      "extra_decimals": 12,
      "can_deposit": true,
      "can_withdraw": true
    },
    "supply_apr": "0.089555187891097479479460623",
    "borrow_apr": "0.139667534982373959872636339",
    "farms": [
      {
        "farm_id": {
          "TokenNetBalance": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
        },
        "rewards": {}
      }
    ]
  }
];

// api.burrow.finance/list_token_data, same moment, rows for the tokens above.
export const MAINNET_API = {
  "code": "0",
  "data": [
    {
      "available_liquidity_balance": "61328.143306",
      "available_liquidity_price": "61314.907466",
      "base_apy": "8.89",
      "borrow_apy": "10.24",
      "max_farm_apy": "0.00",
      "min_farm_apy": "0.00",
      "net_apy": "0.0",
      "net_liquidity_apy": "0.00",
      "price": 0.99978418,
      "supply_apy": "8.89",
      "supply_farm_apy": "0.00",
      "symbol": "USDC.e",
      "token": "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near",
      "total_burrow_balance": "284687.602354",
      "total_burrow_price": "284626.161076",
      "total_supplied_balance": "346077.135193",
      "total_supplied_price": "346002.444826"
    },
    {
      "available_liquidity_balance": "2744287.578994",
      "available_liquidity_price": "10092695.793145",
      "base_apy": "0.33",
      "borrow_apy": "2.52",
      "max_farm_apy": "0.00",
      "min_farm_apy": "0.00",
      "net_apy": "0.0",
      "net_liquidity_apy": "0.00",
      "price": 3.6777107,
      "supply_apy": "0.33",
      "supply_farm_apy": "0.00",
      "symbol": "wNEAR",
      "token": "wrap.near",
      "total_burrow_balance": "586517.162591",
      "total_burrow_price": "2157040.444595",
      "total_supplied_balance": "3333551.776199",
      "total_supplied_price": "12259839.036331"
    },
    {
      "available_liquidity_balance": "2181232.091201",
      "available_liquidity_price": "2178147.654526",
      "base_apy": "7.28",
      "borrow_apy": "11.52",
      "max_farm_apy": "0.00",
      "min_farm_apy": "0.00",
      "net_apy": "0.0",
      "net_liquidity_apy": "0.00",
      "price": 0.99858592,
      "supply_apy": "7.28",
      "supply_farm_apy": "0.00",
      "symbol": "USDt",
      "token": "usdt.tether-token.near",
      "total_burrow_balance": "10602650.172722",
      "total_burrow_price": "10587657.177166",
      "total_supplied_balance": "12786065.679430",
      "total_supplied_price": "12767985.159674"
    },
    {
      "available_liquidity_balance": "2056045.190170",
      "available_liquidity_price": "2055601.454497",
      "base_apy": "8.96",
      "borrow_apy": "13.97",
      "max_farm_apy": "0.00",
      "min_farm_apy": "0.00",
      "net_apy": "0.0",
      "net_liquidity_apy": "0.00",
      "price": 0.99978418,
      "supply_apy": "8.96",
      "supply_farm_apy": "0.00",
      "symbol": "USDC",
      "token": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      "total_burrow_balance": "10946843.049113",
      "total_burrow_price": "10944480.501446",
      "total_supplied_balance": "13004946.342576",
      "total_supplied_price": "13002139.615056"
    }
  ],
  "msg": "success"
};
