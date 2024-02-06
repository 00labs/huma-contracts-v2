### Setup invariant testing environment

Prerequisites: MacOS version 12 or above is required.

Follow [this page](https://book.getfoundry.sh/getting-started/installation) to install Foundry.

Read [Invariant Testing](https://book.getfoundry.sh/forge/invariant-testing#configuring-invariant-test-execution) to understand invariant test better

### Run invariant tests

Run invariant tests for Tranche Vault

```sh
forge test --match-test invariant_Tranche -v
```

Run invariant tests for Redemption Epoch Manager

```sh
forge test --match-test invariant_EpochManager -v
```

Run invariant tests for Pool Fee Manager

```sh
forge test --match-test invariant_PoolFeeManager -v
```

Run invariant tests for First Loss Cover

```sh
forge test --match-test invariant_FLC -v
```

Run invariant tests for Credit Line

```sh
forge test --match-test invariant_CreditLine -v
```

Run invariant tests for Receivable Backed Credit Line

```sh
forge test --match-test invariant_RBCredit -v
```

Pass multiple times to increase the verbosity (e.g. -v, -vv, -vvv).

Verbosity levels:

- 2: Print logs for all tests
- 3: Print execution traces for failing tests
- 4: Print execution traces for all tests, and setup traces for failing tests
- 5: Print execution and setup traces for all tests

Change `run` and `depth` configuration properties

- runs
  Type: integer
  Default: 256
  Environment: FOUNDRY_INVARIANT_RUNS
  The number of runs that must execute for each invariant test group.

- depth
  Type: integer
  Default: 15
  Environment: FOUNDRY_INVARIANT_DEPTH
  The number of calls executed to attempt to break invariants in one run.

### Debug invariant tests

A sequence of function calls is returned if a invariant test fails. It looks like

```
sender=0x0000000000000000000000000000000000001a3d addr=[test/invariant/handlers/CreditLineHandler.sol:CreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=drawdown(uint256,uint256,uint256) args=[18455 [1.845e4], 4614392927512 [4.614e12], 11597 [1.159e4]]
sender=0x00000000000000000000000000000000011d67A5 addr=[test/invariant/handlers/CreditLineHandler.sol:CreditLineHandler]0x5d1F2B24f2f07c4F221CC3dDCfd3185B8F99f69a calldata=drawdown(uint256,uint256,uint256) args=[0, 11463746569123900029188 [1.146e22], 151419055274492630647886040402064834348691834069542595638211528775 [1.514e65]]
sender=0x000000000000000000000000000000000000198b addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=deposit(uint256,uint256,uint256,uint256) args=[65852510840017832 [6.585e16], 115792089237316195423570985008687907853269984665640564039457584007913129639932 [1.157e77], 3, 794895041885095763150322620559 [7.948e29]]
sender=0x092267c8e1766296114a5FA3D02201fB4a0D61CF addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=disburse(uint256,uint256,uint256) args=[115792089237316195423570985008687907853269984665640564039457584007913129639935 [1.157e77], 115792089237316195423570985008687907853269984665640564039457584007913129639933 [1.157e77], 12982382883825859164107948906997 [1.298e31]]
sender=0x3A20313730373138393131343037380000000000 addr=[test/invariant/handlers/LiquidityHandler.sol:LiquidityHandler]0x7712Db7D4a3B3E657f719164B759b0e0308b9Ad5 calldata=deposit(uint256,uint256,uint256,uint256) args=[115792089237316195423570985008687907853269984665640564039457584007913129639934 [1.157e77], 740334503769013376646876543905 [7.403e29], 115792089237316195423570985008687907853269984665640564039457584007913129639934 [1.157e77], 75]
```

1. Copy above sequence to `input` variable of invariant-tool.ts
2. Run `yarn hardhat run scripts/invariant-tool.ts --network hardhat` to get converted code
3. Copy above generated code in `testDebug` function of TestInvariants.t.sol
4. Run `forge test --match-test testDebug -vv` to check detailed error message
