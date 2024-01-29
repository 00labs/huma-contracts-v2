// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseTest} from "./BaseTest.sol";
import {PayPeriodDuration} from "contracts/common/SharedDefs.sol";
import {PoolFactory} from "contracts/factory/PoolFactory.sol";
import {PoolConfig, PoolSettings, LPConfig, FrontLoadingFeesStructure, FeeStructure, FirstLossCoverConfig} from "contracts/common/PoolConfig.sol";
import {BORROWER_LOSS_COVER_INDEX, ADMIN_LOSS_COVER_INDEX, SENIOR_TRANCHE, JUNIOR_TRANCHE} from "contracts/common/SharedDefs.sol";
import {InvariantHandler} from "./handlers/InvariantHandler.sol";
import {EpochManager} from "contracts/liquidity/EpochManager.sol";
import {CreditRecord, CreditConfig, CreditState, DueDetail} from "contracts/credit/CreditStructs.sol";
import {CreditLine} from "contracts/credit/CreditLine.sol";

import "forge-std/console.sol";

contract LiquidityInvariants is BaseTest {
    uint256 constant MAX_CREDIT_LINE = 10_000_000;
    uint256 constant LIQUIDITY_CAP = 10_000_000;
    uint16 constant FIXED_SENIOR_YIELD_BPS = 1000;
    uint16 constant RISK_ADJUSTED_BPS = 1500;
    uint16 constant YIELD_BPS = 1500;

    uint256 checkedEpochId;

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

        // bytes4[] memory selectors = new bytes4[](8);
        // selectors[0] = handler.deposit.selector;
        // selectors[1] = handler.addRedemptionRequest.selector;
        // selectors[2] = handler.cancelRedemptionRequest.selector;
        // selectors[3] = handler.disburse.selector;
        // selectors[4] = handler.processYieldForLenders.selector;
        // selectors[5] = handler.drawdown.selector;
        // selectors[6] = handler.makePayment.selector;
        // selectors[7] = handler.refreshCredit.selector;

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
        assertEq(result, 1000001);
    }

    function testBoundNew2() public {
        uint256 result = handler.boundNew(0, 1000000, 445809192099);
        assertEq(result, 1000000);
    }

    function invariant_test() public {
        assertTrue(false);
        // assertGe(1, 0, "test");
    }

    // A: totalAssets >= totalSupply
    function invariant_Tranche_A() public {
        _assert_Tranche_A();
    }

    function invariant_Tranche_B() public {
        _assert_Tranche_B();
    }

    function invariant_Tranche_C() public {
        _assert_Tranche_C();
    }

    // D: ∑assetsOf >= ∑balanceOf
    // E: ∑balanceOf == totalSupply
    // F: ∑assetsOf == totalAssets
    function invariant_Tranche_D_E_F() public {
        _assert_Tranche_D_E_F();
    }

    function invariant_Tranche_G() public {
        _assert_Tranche_G();
    }

    function invariant_Tranche_H_I() public {
        _assert_Tranche_H_I();
    }

    function invariant_Tranche_J() public {
        _assert_Tranche_J();
    }

    function invariant_EpochManager_A() public {
        _assert_EpochManager_A();
    }

    function invariant_EpochManager_B_C_D_E_F_G() public {
        _assert_EpochManager_B_C_D_E_F_G();
    }

    function invariant_FLC_A() public {
        _assert_FLC_A();
    }

    function invariant_FLC_B() public {
        _assert_FLC_B();
    }

    function invariant_FLC_C() public {
        _assert_FLC_C();
    }

    function invariant_FLC_D() public {
        _assert_FLC_D();
    }

    function test_Tranche_invariants() public {
        _assert_Tranche_A();
        _assert_Tranche_B();
        _assert_Tranche_D_E_F();
        _assert_Tranche_G();
        _assert_Tranche_H_I();
        _assert_Tranche_J();
    }

    function test_EpochManager_invariants() public {
        _assert_EpochManager_A();
        _assert_EpochManager_B_C_D_E_F_G();
    }

    function test_FLC_invariants() public {
        _assert_FLC_A();
        _assert_FLC_B();
        _assert_FLC_C();
        _assert_FLC_D();
    }

    function testDebug() public {
        handler.disburse(511, 18732, 1115958799);
        handler.drawdown(
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            0,
            115792089237316195423570985008687907853269984665640564039457584007913129639934
        );
        handler.drawdown(4773, 9503, 15334);
        handler.makePayment(
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            115792089237316195423570985008687907853269984665640564039457584007913129639935
        );
        handler.cancelRedemptionRequest(
            307351878326496349646861946412211957386772448903113552090633114,
            2,
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            115792089237316195423570985008687907853269984665640564039457584007913129639935
        );
        handler.drawdown(
            12965627532955235,
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            34271968774548698554216071258149267
        );
        handler.addRedemptionRequest(10467, 14373, 12718, 19180);
        handler.drawdown(
            4696101871635116613687179390375553842905116356921,
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            0
        );
        handler.cancelRedemptionRequest(
            3,
            142865224980,
            3203463038928617776283565669072150091243907203013574266905857603663,
            9629713799523486109640678726817266933822504961979653993916971138404029
        );
        handler.deposit(
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            196169082861832774685458594841127741270096699,
            1,
            115792089237316195423570985008687907853269984665640564039457584007913129639932
        );
        _assert_Tranche_H_I();
    }

    function invariant_displayCallsLog() public view {
        handler.displayCallsLog();
    }

    function _assert_Tranche_A() internal {
        assertGe(
            seniorTranche.totalAssets(),
            seniorTranche.totalSupply(),
            "Senior Tranche Invariant A"
        );
        assertGe(
            juniorTranche.totalAssets(),
            juniorTranche.totalSupply(),
            "Junior Tranche Invariant A"
        );
    }

    function _assert_Tranche_B() internal {
        assertEq(
            seniorTranche.convertToAssets(seniorTranche.totalSupply()),
            seniorTranche.totalAssets(),
            "Senior Invariant B"
        );
        assertEq(
            juniorTranche.convertToAssets(juniorTranche.totalSupply()),
            juniorTranche.totalAssets(),
            "Junior Invariant B"
        );
    }

    function _assert_Tranche_C() internal {
        assertEq(
            seniorTranche.convertToShares(seniorTranche.totalAssets()),
            seniorTranche.totalSupply(),
            "Senior Invariant C"
        );
        assertEq(
            juniorTranche.convertToShares(juniorTranche.totalAssets()),
            juniorTranche.totalSupply(),
            "Junior Invariant C"
        );
    }

    function _assert_Tranche_D_E_F() internal {
        uint256 allSeniorBalanceOf = seniorInitialShares +
            seniorTranche.balanceOf(address(seniorTranche));
        uint256 allSeniorAssetsOf = seniorTranche.convertToAssets(allSeniorBalanceOf);
        uint256 allJuniorBalanceOf = juniorInitialShares +
            juniorTranche.balanceOf(address(juniorTranche));
        uint256 allJuniorAssetsOf = juniorTranche.convertToAssets(allJuniorBalanceOf);

        uint256 len = lenders.length;
        for (uint256 i = 0; i < len; ++i) {
            address lender = lenders[i];
            uint256 balanceOf = seniorTranche.balanceOf(lender);
            allSeniorBalanceOf += balanceOf;
            uint256 assetsOf;
            if (balanceOf > 0) {
                assetsOf = seniorTranche.totalAssetsOf(lender);
                assertGe(
                    assetsOf,
                    balanceOf,
                    string.concat(
                        "Senior Tranche Invariant D - ",
                        vm.toString(i),
                        ", ",
                        vm.toString(lender)
                    )
                );
                allSeniorAssetsOf += assetsOf;
            }
            balanceOf = juniorTranche.balanceOf(lender);
            allJuniorBalanceOf += balanceOf;
            if (balanceOf > 0) {
                assetsOf = juniorTranche.totalAssetsOf(lender);
                assertGe(
                    assetsOf,
                    balanceOf,
                    string.concat(
                        "Junior Tranche Invariant D - ",
                        vm.toString(i),
                        ", ",
                        vm.toString(lender)
                    )
                );
                allJuniorAssetsOf += assetsOf;
            }
        }

        assertEq(seniorTranche.totalSupply(), allSeniorBalanceOf, "Senior Invariant E");
        assertEq(juniorTranche.totalSupply(), allJuniorBalanceOf, "Junior Invariant E");
        assertApproxEqAbs(
            seniorTranche.totalAssets(),
            allSeniorAssetsOf,
            len,
            "Senior Invariant F"
        );
        assertApproxEqAbs(
            juniorTranche.totalAssets(),
            allJuniorAssetsOf,
            len,
            "Junior Invariant F"
        );
    }

    function _assert_Tranche_G() internal {
        uint256 len = borrowers.length;
        uint256 totalCreditPrincipal;
        for (uint256 i = 0; i < len; ++i) {
            address borrower = borrowers[i];
            (CreditRecord memory cr, DueDetail memory dd) = creditLine.getDueInfo(borrower);
            totalCreditPrincipal +=
                cr.unbilledPrincipal +
                cr.nextDue -
                cr.yieldDue +
                dd.principalPastDue;
        }
        assertGe(
            pool.totalAssets(),
            totalCreditPrincipal +
                poolSafe.getAvailableBalanceForPool() +
                poolSafe.unprocessedTrancheProfit(address(seniorTranche)) +
                poolSafe.unprocessedTrancheProfit(address(juniorTranche)),
            "Tranche Invariant G"
        );
    }

    function _assert_Tranche_H_I() internal {
        uint256 len = lenders.length;
        uint256 timestamp = block.timestamp;
        for (uint256 i = 0; i < len; ++i) {
            address lender = lenders[i];
            (uint256 principal, , uint256 lastDepositTime) = seniorTranche.depositRecords(lender);
            if (lastDepositTime > 0) {
                // deposit, addRedemptionRequest may cause rounding error to make totalAssetsOf < principal
                assertGe(
                    seniorTranche.totalAssetsOf(lender) + 5,
                    principal,
                    string.concat(
                        "Senior Tranche Invariant H - ",
                        vm.toString(i),
                        ", ",
                        vm.toString(lender)
                    )
                );
                // assertTrue(
                //     timestamp >= lastDepositTime
                //     // string.concat(
                //     //     "Senior Tranche Invariant I - ",
                //     //     vm.toString(i),
                //     //     ", ",
                //     //     vm.toString(lender)
                //     // )
                // );
            }

            (principal, , lastDepositTime) = juniorTranche.depositRecords(lender);
            if (lastDepositTime > 0) {
                assertGe(
                    juniorTranche.totalAssetsOf(lender) + 5,
                    principal,
                    string.concat(
                        "Junior Tranche Invariant H - ",
                        vm.toString(i),
                        ", ",
                        vm.toString(lender)
                    )
                );
                // assertLe(
                //     lastDepositTime,
                //     timestamp,
                //     string.concat(
                //         "Junior Tranche Invariant I - ",
                //         vm.toString(i),
                //         ", ",
                //         vm.toString(lender)
                //     )
                // );
            }
        }
    }

    function _assert_Tranche_J() internal {
        assertGe(
            poolSafe.totalBalance(),
            poolSafe.unprocessedTrancheProfit(address(seniorTranche)) +
                poolSafe.unprocessedTrancheProfit(address(juniorTranche)),
            "Tranche Invariant J"
        );
    }

    function _assert_EpochManager_A() internal {
        EpochManager.CurrentEpoch memory epoch = epochManager.currentEpoch();
        assertGt(epoch.endTime, block.timestamp, "EpochManager Invariant A");
    }

    // function _assert_EpochManager_B() internal {
    //     uint256 currentEpochId = epochManager.currentEpochId();
    //     if (currentEpochId - 1 > checkedEpochId) {
    //         uint256 i;
    //         for (; i < currentEpochId - 1 - checkedEpochId; ++i) {
    //             (, uint256 totalSharesRequested, uint256 totalSharesProcessed, ) = seniorTranche
    //                 .epochRedemptionSummaries(checkedEpochId + 1 + i);
    //             assertGe(
    //                 totalSharesRequested,
    //                 totalSharesProcessed,
    //                 string.concat(
    //                     "Senior Tranche EpochManager Invariant B - ",
    //                     vm.toString(checkedEpochId + 1 + i)
    //                 )
    //             );
    //             (, totalSharesRequested, totalSharesProcessed, ) = juniorTranche
    //                 .epochRedemptionSummaries(checkedEpochId + 1 + i);
    //             assertGe(
    //                 totalSharesRequested,
    //                 totalSharesProcessed,
    //                 string.concat(
    //                     "Junior Tranche EpochManager Invariant B - ",
    //                     vm.toString(checkedEpochId + 1 + i)
    //                 )
    //             );
    //         }
    //         checkedEpochId += i;
    //     }
    // }

    function _assert_EpochManager_B_C_D_E_F_G() internal {
        uint256 currentEpochId = epochManager.currentEpochId();
        uint256 seniorEpochesAmountProcessed;
        uint256 juniorEpochesAmountProcessed;
        if (currentEpochId - 1 > checkedEpochId) {
            uint256 i;
            for (; i < currentEpochId - 1 - checkedEpochId; ++i) {
                (
                    ,
                    uint256 totalSharesRequested,
                    uint256 totalSharesProcessed,
                    uint256 totalAmountProcessed
                ) = seniorTranche.epochRedemptionSummaries(checkedEpochId + 1 + i);
                assertGe(
                    totalSharesRequested,
                    totalSharesProcessed,
                    string.concat(
                        "Senior Tranche EpochManager Invariant B - ",
                        vm.toString(checkedEpochId + 1 + i)
                    )
                );
                seniorEpochesAmountProcessed += totalAmountProcessed;
                (
                    ,
                    totalSharesRequested,
                    totalSharesProcessed,
                    totalAmountProcessed
                ) = juniorTranche.epochRedemptionSummaries(checkedEpochId + 1 + i);
                (, totalSharesRequested, totalSharesProcessed, ) = juniorTranche
                    .epochRedemptionSummaries(checkedEpochId + 1 + i);
                assertGe(
                    totalSharesRequested,
                    totalSharesProcessed,
                    string.concat(
                        "Junior Tranche EpochManager Invariant B - ",
                        vm.toString(checkedEpochId + 1 + i)
                    )
                );
                juniorEpochesAmountProcessed += totalAmountProcessed;
            }
            checkedEpochId += i;
        }

        uint256 len = lenders.length;
        uint256 seniorLendersRedemption;
        uint256 juniorLendersRedemption;
        uint256 seniorLendersWithdrawable;
        uint256 juniorLendersWithdrawable;
        uint256 seniorLendersAmountProcessed;
        uint256 juniorLendersAmountProcessed;
        for (uint256 i = 0; i < len; ++i) {
            address lender = lenders[i];
            (
                uint256 nextEpochIdToProcess,
                ,
                ,
                uint256 totalAmountProcessed,
                uint256 totalAmountWithdrawn
            ) = seniorTranche.lenderRedemptionRecords(lender);
            assertGe(
                currentEpochId,
                nextEpochIdToProcess,
                "Senior Tranche EpochManager Invariant C"
            );
            assertEq(
                totalAmountProcessed,
                totalAmountWithdrawn + handler.lendersWithdrawn(lender, SENIOR_TRANCHE),
                "Senior Tranche EpochManager Invariant D"
            );
            seniorLendersAmountProcessed += totalAmountProcessed;
            (nextEpochIdToProcess, , , totalAmountProcessed, totalAmountWithdrawn) = juniorTranche
                .lenderRedemptionRecords(lender);
            assertGe(
                currentEpochId,
                nextEpochIdToProcess,
                "Junior Tranche EpochManager Invariant C"
            );
            assertEq(
                totalAmountProcessed,
                totalAmountWithdrawn + handler.lendersWithdrawn(lender, JUNIOR_TRANCHE),
                "Junior Tranche EpochManager Invariant D"
            );
            juniorLendersAmountProcessed += totalAmountProcessed;

            seniorLendersRedemption += seniorTranche.cancellableRedemptionShares(lender);
            juniorLendersRedemption += juniorTranche.cancellableRedemptionShares(lender);
            seniorLendersWithdrawable += seniorTranche.withdrawableAssets(lender);
            juniorLendersWithdrawable += juniorTranche.withdrawableAssets(lender);
        }

        (, uint256 totalSharesRequested, , ) = seniorTranche.epochRedemptionSummaries(
            currentEpochId
        );
        assertEq(
            totalSharesRequested,
            seniorLendersRedemption,
            "Senior Tranche EpochManager Invariant E1"
        );
        assertEq(
            totalSharesRequested,
            seniorTranche.balanceOf(address(seniorTranche)),
            "Junior Tranche EpochManager Invariant E2"
        );
        (, totalSharesRequested, , ) = juniorTranche.epochRedemptionSummaries(currentEpochId);
        assertEq(
            totalSharesRequested,
            juniorLendersRedemption,
            "Junior Tranche EpochManager Invariant E1"
        );
        assertEq(
            totalSharesRequested,
            juniorTranche.balanceOf(address(juniorTranche)),
            "Junior Tranche EpochManager Invariant E2"
        );
        assertEq(
            seniorLendersWithdrawable,
            mockToken.balanceOf(address(seniorTranche)),
            "Senior Tranche EpochManager Invariant F"
        );
        assertEq(
            juniorLendersWithdrawable,
            mockToken.balanceOf(address(juniorTranche)),
            "Junior Tranche EpochManager Invariant F"
        );
        assertEq(
            seniorEpochesAmountProcessed,
            seniorLendersAmountProcessed,
            "Senior Tranche EpochManager Invariant G1"
        );
        assertEq(
            juniorEpochesAmountProcessed,
            juniorLendersAmountProcessed,
            "Junior Tranche EpochManager Invariant G1"
        );
        assertEq(
            seniorEpochesAmountProcessed,
            handler.amountsTransferredToTranches(SENIOR_TRANCHE),
            "Senior Tranche EpochManager Invariant G2"
        );
        assertEq(
            juniorEpochesAmountProcessed,
            handler.amountsTransferredToTranches(JUNIOR_TRANCHE),
            "Junior Tranche EpochManager Invariant G2"
        );
    }

    function _assert_FLC_A() internal {
        assertGe(adminFLC.totalAssets(), adminFLC.totalSupply(), "FLC Invariant A");
    }

    function _assert_FLC_B() internal {
        assertEq(
            adminFLC.convertToAssets(adminFLC.totalSupply()),
            adminFLC.totalAssets(),
            "FLC Invariant B"
        );
    }

    function _assert_FLC_C() internal {
        assertEq(
            adminFLC.convertToShares(adminFLC.totalAssets()),
            adminFLC.totalSupply(),
            "FLC Invariant C"
        );
    }

    function _assert_FLC_D() internal {
        assertGe(
            adminFLC.totalAssets(),
            poolConfig.getFirstLossCoverConfig(address(adminFLC)).minLiquidity,
            "FLC Invariant D"
        );
    }
}
