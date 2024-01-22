// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseTest} from "./BaseTest.sol";
import {PayPeriodDuration} from "contracts/common/SharedDefs.sol";
import {PoolFactory} from "contracts/factory/PoolFactory.sol";
import {PoolConfig, PoolSettings, LPConfig, FrontLoadingFeesStructure, FeeStructure, FirstLossCoverConfig} from "contracts/common/PoolConfig.sol";
import {BORROWER_LOSS_COVER_INDEX, ADMIN_LOSS_COVER_INDEX} from "contracts/common/SharedDefs.sol";
import {InvariantHandler} from "./handlers/InvariantHandler.sol";
import {EpochManager} from "contracts/liquidity/EpochManager.sol";

import "forge-std/console.sol";

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
                0
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

        // EpochManager.CurrentEpoch memory epoch = EpochManager(poolConfig.epochManager())
        //     .currentEpoch();
        // console.log(
        //     "epoch.id: %s, epoch.endTime: %s, timestamp: %s",
        //     epoch.id,
        //     epoch.endTime,
        //     vm.unixTime()
        // );

        _createUsers(10, 10);
        _approveBorrowers(_toToken(MAX_CREDIT_LINE) / 2, YIELD_BPS);

        handler = new InvariantHandler(address(poolConfig), lenders, borrowers);

        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.deposit.selector;
        selectors[2] = handler.deposit.selector;
        selectors[3] = handler.addRedemptionRequest.selector;
        selectors[4] = handler.addRedemptionRequest.selector;
        selectors[5] = handler.cancelRedemptionRequest.selector;
        selectors[6] = handler.disburse.selector;
        selectors[7] = handler.processYieldForLenders.selector;
        selectors[8] = handler.drawdown.selector;
        selectors[9] = handler.drawdown.selector;
        selectors[10] = handler.drawdown.selector;
        selectors[11] = handler.makePayment.selector;
        selectors[12] = handler.makePayment.selector;
        selectors[13] = handler.refreshCredit.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function testSetUp() public {
        assertTrue(true);
    }

    function testDeposit() public {
        handler.deposit(
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            3694087947,
            9093720506176389639203518624136341032157519068214917631426822148,
            26447
        );
    }

    function testBoundNew1() public {
        uint256 result = handler.boundNew(10089, 1000000, 1000000);
        assertEq(result, 1000000);
    }

    function testBoundNew2() public {
        uint256 result = handler.boundNew(0, 1000000, 445809192099);
        assertEq(result, 1000000);
    }

    function invariant_test() public {
        assertTrue(true);
    }

    function invariant_displayCallsLog() public {
        handler.displayCallsLog();
    }

    function testDebug() public {
        handler.deposit(9870, 8907825045910, 445809192099, 2701654899094);
        handler.addRedemptionRequest(
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            645256870901728329557187875423392137041357850783475326,
            0,
            83621979255504419162149328494102742496485024
        );
        handler.cancelRedemptionRequest(1266, 13249, 10089, 400100020652);
    }
}
