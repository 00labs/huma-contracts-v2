// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {BaseTest} from "./BaseTest.sol";
import {EpochManager} from "contracts/liquidity/EpochManager.sol";
import {PayPeriodDuration} from "contracts/common/SharedDefs.sol";
import {PoolSettings, LPConfig, FrontLoadingFeesStructure, FeeStructure, FirstLossCoverConfig} from "contracts/common/PoolConfig.sol";
import {BORROWER_LOSS_COVER_INDEX, ADMIN_LOSS_COVER_INDEX, SENIOR_TRANCHE, JUNIOR_TRANCHE, HUNDRED_PERCENT_IN_BPS} from "contracts/common/SharedDefs.sol";
import {CreditRecord, CreditConfig, CreditState, DueDetail} from "contracts/credit/CreditStructs.sol";

import "forge-std/console.sol";

struct PoolDeployParameters {
    uint96 maxCreditLimit;
    uint96 liquidityCap;
    uint16 fixedSeniorYieldBps;
    uint16 riskAdjustedBps;
    uint16 creditYieldBps;
    string tranchesPolicyType;
    string creditType;
}

contract BaseInvariants is BaseTest {
    uint256 minReinvestFees;

    bytes4[] selectors;
    mapping(bytes4 => string) public names;
    mapping(bytes4 => uint256) calls;
    mapping(bytes4 => uint256) validCalls;
    uint256 callNum;

    uint256 public currentEpochEndTime;
    mapping(uint256 => uint256) public amountsTransferredToTranches;
    bool public hasProfit;

    uint256 checkedEpochId;
    mapping(address => mapping(uint256 => uint256)) public lendersWithdrawn;

    function addSelector(bytes4 selector, string memory name) public {
        selectors.push(selector);
        names[selector] = name;
    }

    function increaselogCall(bytes4 selector) public returns (uint256) {
        ++callNum;
        ++calls[selector];
        return callNum;
    }

    function increaseValidCalls(bytes4 selector) public {
        ++validCalls[selector];
    }

    function advanceTimestamp(uint256 timeSeed) public {
        uint256 timestamp = block.timestamp;
        uint256 typeIndex = _boundNew(timeSeed, 0, 1);
        if (typeIndex == 0) {
            uint256 hourNum = _boundNew(timeSeed, 1, 24);
            timestamp += hourNum * 1 hours;
        } else {
            uint256 dayNum = _boundNew(timeSeed, 1, 30);
            timestamp += dayNum * 1 days;
        }
        vm.warp(timestamp);
        if (timestamp > currentEpochEndTime) {
            _closeEpoch();
        }
    }

    function setHasProfit(bool _hasProfit) public {
        hasProfit = _hasProfit;
    }

    function increaseLenderWithdrawn(address lender, uint256 trancheIndex, uint256 amount) public {
        lendersWithdrawn[lender][trancheIndex] += amount;
    }

    function displayCallsLog() public view {
        console.log("--------------------");
        console.log("calls: ");
        console.log("--------------------");
        uint256 len = selectors.length;
        uint256 total;
        for (uint256 i = 0; i < len; i++) {
            bytes4 selector = selectors[i];
            string memory name = names[selector];
            uint256 count = calls[selector];
            console.log("%s: %s", name, count);
            total += count;
        }
        console.log("total calls: %s", total);
        console.log("--------------------");

        console.log("validCalls: ");
        console.log("--------------------");
        total = 0;
        for (uint256 i = 0; i < len; i++) {
            bytes4 selector = selectors[i];
            string memory name = names[selector];
            uint256 count = validCalls[selector];
            console.log("%s: %s", name, count);
            total += count;
        }
        console.log("total valid calls: %s", total);
        console.log("--------------------");
    }

    function _setUp(
        PoolDeployParameters memory parameters,
        uint256 lenderNum,
        uint256 borrowerNum
    ) internal {
        _deployPool(parameters.tranchesPolicyType, parameters.creditType);

        vm.startPrank(poolOwner);
        poolConfig.setPoolSettings(
            PoolSettings(
                uint96(_toToken(parameters.maxCreditLimit)),
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
                uint96(_toToken(parameters.liquidityCap)),
                4,
                parameters.fixedSeniorYieldBps,
                parameters.riskAdjustedBps,
                0
            )
        );
        poolConfig.setFrontLoadingFees(FrontLoadingFeesStructure(0, 1000));
        poolConfig.setFeeStructure(FeeStructure(parameters.creditYieldBps, 0, 1200));
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
                uint96(_toToken(1_010_000)),
                uint96(_toToken(1_000_000)),
                15000
            )
        );
        vm.stopPrank();

        _enablePool();

        _createLenders(lenderNum);
        _createBorrowers(borrowerNum);

        _updateCurrentEpochEndTime();
        minReinvestFees = _toToken(1000);
    }

    function _closeEpoch() internal {
        console.log(
            "close epoch - block.tiemstamp: %s, currentEpochEndTime: %s",
            block.timestamp,
            currentEpochEndTime
        );
        console.log("closeEpoch starts...");
        if (hasProfit) {
            console.log("processYieldForLenders starts...");
            if (poolSafe.unprocessedTrancheProfit(address(seniorTranche)) > 0) {
                seniorTranche.processYieldForLenders();
            }
            if (poolSafe.unprocessedTrancheProfit(address(juniorTranche)) > 0) {
                juniorTranche.processYieldForLenders();
            }
            console.log("processYieldForLenders done.");
        }
        uint256 seniorAssetsBefore = mockToken.balanceOf(address(seniorTranche));
        uint256 juniorAssetsBefore = mockToken.balanceOf(address(juniorTranche));
        epochManager.closeEpoch();
        uint256 seniorAssetsAfter = mockToken.balanceOf(address(seniorTranche));
        uint256 juniorAssetsAfter = mockToken.balanceOf(address(juniorTranche));
        if (seniorAssetsAfter > seniorAssetsBefore) {
            amountsTransferredToTranches[SENIOR_TRANCHE] += seniorAssetsAfter - seniorAssetsBefore;
        }
        if (juniorAssetsAfter > juniorAssetsBefore) {
            amountsTransferredToTranches[JUNIOR_TRANCHE] += juniorAssetsAfter - juniorAssetsBefore;
        }
        _updateCurrentEpochEndTime();
        if (hasProfit) {
            console.log("investFeesInFirstLossCover starts...");
            uint256 fees = poolFeeManager.getAvailableFeesToInvestInFirstLossCover();
            if (fees > minReinvestFees) {
                vm.startPrank(sentinelServiceAccount);
                poolFeeManager.investFeesInFirstLossCover();
                vm.stopPrank();
            }
            console.log("investFeesInFirstLossCover done.");
            if (adminFLC.getAvailableCap() == 0) {
                console.log("payoutYield starts...");
                adminFLC.payoutYield();
                console.log("payoutYield done.");
            }
        }
        hasProfit = false;
        console.log("closeEpoch done.");
    }

    function _updateCurrentEpochEndTime() internal {
        EpochManager.CurrentEpoch memory epoch = epochManager.currentEpoch();
        currentEpochEndTime = epoch.endTime;
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
        // uint256 timestamp = block.timestamp;
        for (uint256 i = 0; i < len; ++i) {
            address lender = lenders[i];
            string memory lenderStr = string.concat(vm.toString(i), ", ", vm.toString(lender));
            (uint256 principal, , uint256 lastDepositTime) = seniorTranche.depositRecords(lender);
            if (lastDepositTime > 0) {
                // deposit, addRedemptionRequest may cause rounding error to make totalAssetsOf < principal
                assertGe(
                    seniorTranche.totalAssetsOf(lender) + 5,
                    principal,
                    string.concat("Senior Tranche Invariant H - ", lenderStr)
                );
                // assertGe(timestamp, lastDepositTime, "Senior Tranche Invariant I");
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
                    string.concat("Junior Tranche Invariant H - ", lenderStr)
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

    function _assert_Tranche_K() internal {
        assertGe(
            juniorTranche.totalAssets() * poolConfig.getLPConfig().maxSeniorJuniorRatio,
            seniorTranche.totalAssets(),
            "Tranche Invariant K"
        );
    }

    function _assert_EpochManager_A() internal {
        EpochManager.CurrentEpoch memory epoch = epochManager.currentEpoch();
        assertGt(epoch.endTime, block.timestamp, "EpochManager Invariant A");
    }

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
                totalAmountWithdrawn + lendersWithdrawn[lender][SENIOR_TRANCHE],
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
                totalAmountWithdrawn + lendersWithdrawn[lender][JUNIOR_TRANCHE],
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
            amountsTransferredToTranches[SENIOR_TRANCHE],
            "Senior Tranche EpochManager Invariant G2"
        );
        assertEq(
            juniorEpochesAmountProcessed,
            amountsTransferredToTranches[JUNIOR_TRANCHE],
            "Junior Tranche EpochManager Invariant G2"
        );
    }

    function _assert_PoolFeeManager_A() internal {
        assertGe(
            poolSafe.getAvailableBalanceForFees(),
            poolFeeManager.getTotalAvailableFees(),
            "PoolFeeManager Invariant A"
        );
    }

    function _assert_PoolFeeManager_B() internal {
        assertGe(
            poolFeeManager.getAccruedIncomes().protocolIncome,
            poolFeeManager.protocolIncomeWithdrawn(),
            "PoolFeeManager Invariant B"
        );
    }

    function _assert_PoolFeeManager_C() internal {
        assertGe(
            poolFeeManager.getAccruedIncomes().poolOwnerIncome,
            poolFeeManager.poolOwnerIncomeWithdrawn(),
            "PoolFeeManager Invariant C"
        );
    }

    function _assert_PoolFeeManager_D() internal {
        assertGe(
            poolFeeManager.getAccruedIncomes().eaIncome,
            poolFeeManager.eaIncomeWithdrawn(),
            "PoolFeeManager Invariant D"
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

    function _assert_Credit_A_B_C_D() internal {
        uint256 len = borrowers.length;
        uint256 timestamp = block.timestamp;
        for (uint256 i = 0; i < len; ++i) {
            address borrower = borrowers[i];
            string memory borrowerStr = string.concat(vm.toString(i), ", ", vm.toString(borrower));
            (CreditRecord memory cr, DueDetail memory dd) = creditLine.getDueInfo(borrower);
            CreditConfig memory cc = creditManager.getCreditConfig(
                keccak256(abi.encode(address(creditLine), borrower))
            );
            assertGe(
                cc.creditLimit,
                cr.unbilledPrincipal + cr.nextDue - cr.yieldDue + dd.principalPastDue,
                string.concat("Credit Invariant A - ", borrowerStr)
            );
            if (cr.state == CreditState.GoodStanding || cr.state == CreditState.Delayed) {
                assertGt(
                    cr.nextDueDate,
                    timestamp,
                    string.concat("Credit Invariant B - ", borrowerStr)
                );
            }
            assertGe(
                cc.numOfPeriods,
                cr.remainingPeriods,
                string.concat("Credit Invariant C - ", borrowerStr)
            );
            if (cr.state == CreditState.Defaulted || cr.state == CreditState.Delayed) {
                assertGt(cr.totalPastDue, 0, string.concat("Credit Invariant D1 - ", borrowerStr));
                assertGt(
                    cr.missedPeriods,
                    0,
                    string.concat("Credit Invariant D2 - ", borrowerStr)
                );
            }
        }
    }
}
