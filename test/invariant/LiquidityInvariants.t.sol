// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseTest} from "./BaseTest.sol";
import {PayPeriodDuration} from "contracts/common/SharedDefs.sol";
import {PoolFactory} from "contracts/factory/PoolFactory.sol";
import {PoolConfig, PoolSettings, LPConfig, FrontLoadingFeesStructure, FeeStructure, FirstLossCoverConfig} from "contracts/common/PoolConfig.sol";
import {BORROWER_LOSS_COVER_INDEX, ADMIN_LOSS_COVER_INDEX} from "contracts/common/SharedDefs.sol";
import {TrancheVaultHandler} from "./handlers/TrancheVaultHandler.sol";

contract LiquidityInvariants is BaseTest {
    uint256 constant MAX_CREDIT_LINE = 10_000_000;
    uint256 constant LIQUIDITY_CAP = 10_000_000;
    uint16 constant FIXED_SENIOR_YIELD_BPS = 1000;
    uint16 constant RISK_ADJUSTED_BPS = 1500;
    uint16 constant YIELD_BPS = 1500;

    function setUp() public override {
        super.setUp();

        _deployPool(FIXED_SENIOR_YIELD_TRANCHES_POLICY, CREDIT_LINE);
        PoolFactory.PoolRecord memory poolRecord = poolFactory.checkPool(poolId);
        PoolConfig poolConfig = PoolConfig(poolRecord.poolConfigAddress);

        vm.startPrank(poolOwner);
        poolConfig.setPoolSettings(
            PoolSettings(
                uint96(_toToken(MAX_CREDIT_LINE)),
                uint96(_toToken(100)),
                PayPeriodDuration.Monthly,
                5,
                90,
                10000,
                true
            )
        );
        poolConfig.setLPConfig(
            LPConfig(
                uint96(_toToken(LIQUIDITY_CAP)),
                4,
                FIXED_SENIOR_YIELD_BPS,
                RISK_ADJUSTED_BPS,
                90
            )
        );
        poolConfig.setFrontLoadingFees(FrontLoadingFeesStructure(0, 1000));
        poolConfig.setFeeStructure(FeeStructure(YIELD_BPS, 0, 1200));
        poolConfig.setPoolOwnerRewardsAndLiquidity(200, 200);
        poolConfig.setEARewardsAndLiquidity(200, 200);
        poolConfig.setFirstLossCover(
            uint8(BORROWER_LOSS_COVER_INDEX),
            poolConfig.getFirstLossCover(BORROWER_LOSS_COVER_INDEX),
            FirstLossCoverConfig(
                1000,
                uint96(_toToken(100_000)),
                uint96(_toToken(1_000_000)),
                uint96(_toToken(1_000_000)),
                0
            )
        );
        poolConfig.setFirstLossCover(
            uint8(ADMIN_LOSS_COVER_INDEX),
            poolConfig.getFirstLossCover(ADMIN_LOSS_COVER_INDEX),
            FirstLossCoverConfig(
                1000,
                uint96(_toToken(100_000)),
                uint96(_toToken(3_000_000)),
                uint96(_toToken(1_000_000)),
                15000
            )
        );
        vm.stopPrank();

        _enablePool();

        _createUsers(10, 3);

        trancheVaultHandler = new TrancheVaultHandler(address(poolConfig), lenders);

        targetContract(address(trancheVaultHandler));
    }

    function testSetUp() public {
        assertTrue(true);
    }

    function testDeposit() public {
        trancheVaultHandler.deposit(
            243649340185278139112546181411400640149353630979,
            19114,
            4081479161
        );
    }

    function invariant_test() public {
        assertTrue(true);
    }
}
