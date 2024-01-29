// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig, PoolSettings} from "contracts/common/PoolConfig.sol";
import {TrancheVault} from "contracts/liquidity/TrancheVault.sol";
import {MockToken} from "contracts/common/mock/MockToken.sol";
import {Pool} from "contracts/liquidity/Pool.sol";
import {PoolSafe} from "contracts/liquidity/PoolSafe.sol";
import {EpochManager} from "contracts/liquidity/EpochManager.sol";
import {PoolFeeManager} from "contracts/liquidity/PoolFeeManager.sol";
import {CreditLine} from "contracts/credit/CreditLine.sol";
import {CreditDueManager} from "contracts/credit/CreditDueManager.sol";
import {CreditLineManager} from "contracts/credit/CreditLineManager.sol";
import {CreditRecord, CreditConfig, CreditState} from "contracts/credit/CreditStructs.sol";
import {SENIOR_TRANCHE, JUNIOR_TRANCHE} from "contracts/common/SharedDefs.sol";

import {Test} from "forge-std/Test.sol";
import "forge-std/console.sol";

contract InvariantHandler is Test {
    uint256 immutable decimals;
    uint256 immutable minRedemptionShares;
    uint256 immutable minDrawdownAmount;
    uint256 immutable minPaymentAmount;
    uint256 immutable minReinvestFees;

    TrancheVault[] tranches;
    MockToken mockToken;
    Pool pool;
    PoolSafe poolSafe;
    EpochManager epochManager;
    PoolFeeManager poolFeeManager;

    CreditLine creditLine;
    CreditLineManager creditLineManager;
    CreditDueManager creditDueManager;

    address sentinelServiceAccount;

    uint256 minDepositAmount;
    uint256 currentEpochEndTime;

    address[] lenders;
    mapping(uint256 => address[]) investedLendersByTranche;
    mapping(uint256 => address[]) redeemedLendersByTranche;
    mapping(address => mapping(uint256 => uint256)) public lendersWithdrawn;
    mapping(uint256 => uint256) public amountsTransferredToTranches;

    address[] borrowers;
    address[] borrowedBorrowers;

    bool hasProfit;

    mapping(bytes4 => uint256) calls;
    mapping(bytes4 => uint256) validCalls;
    uint256 callNum;

    modifier logCall(bytes4 selector, string memory prefix) {
        callNum++;
        calls[selector]++;
        console.log("%s starts... callNum: %s, timestmap: %s", prefix, callNum, vm.unixTime());
        _;
        console.log("%s done... callNum: %s, timestmap: %s", prefix, callNum, vm.unixTime());
        console.log("--------------------");
    }

    modifier advanceTimestamp(uint256 timeSeed) {
        console.log(
            "before currentEpochEndTime: %s, block.timestamp: %s",
            currentEpochEndTime,
            block.timestamp
        );
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

        _;

        console.log(
            "after currentEpochEndTime: %s, block.timestamp: %s",
            currentEpochEndTime,
            block.timestamp
        );
    }

    constructor(address _poolConfig, address[] memory _lenders, address[] memory _borrowers) {
        PoolConfig poolConfig = PoolConfig(_poolConfig);
        tranches.push(TrancheVault(poolConfig.seniorTranche()));
        tranches.push(TrancheVault(poolConfig.juniorTranche()));
        pool = Pool(poolConfig.pool());
        poolSafe = PoolSafe(poolConfig.poolSafe());
        mockToken = MockToken(poolConfig.underlyingToken());
        epochManager = EpochManager(poolConfig.epochManager());
        poolFeeManager = PoolFeeManager(poolConfig.poolFeeManager());
        lenders = _lenders;

        creditLine = CreditLine(poolConfig.credit());
        creditLineManager = CreditLineManager(poolConfig.creditManager());
        creditDueManager = CreditDueManager(poolConfig.creditDueManager());
        borrowers = _borrowers;

        sentinelServiceAccount = poolConfig.humaConfig().sentinelServiceAccount();
        minDepositAmount = poolConfig.getPoolSettings().minDepositAmount;
        decimals = mockToken.decimals();
        minRedemptionShares = _toToken(1);
        minDrawdownAmount = _toToken(100000);
        minPaymentAmount = _toToken(1000);
        minReinvestFees = _toToken(1000);

        _updateCurrentEpochEndTime();
    }

    function deposit(
        uint256 trancheSeed,
        uint256 lenderSeed,
        uint256 amountSeed,
        uint256 timeSeed
    ) public logCall(this.deposit.selector, "deposit") advanceTimestamp(timeSeed) {
        uint256 trancheIndex = _boundNew(trancheSeed, 0, tranches.length - 1);
        TrancheVault tranche = tranches[trancheIndex];
        uint256 lenderIndex = _boundNew(lenderSeed, 0, lenders.length - 1);
        address lender = lenders[lenderIndex];
        uint256 maxDepositAmount = pool.getTrancheAvailableCap(trancheIndex);
        if (minDepositAmount > maxDepositAmount) {
            return;
        }
        uint256 depositAmount = _boundNew(amountSeed, minDepositAmount, maxDepositAmount);
        // console.log(
        //     "valid deposit - amountSeed: %s, minDepositAmount: %s, maxDepositAmount: %s",
        //     amountSeed,
        //     minDepositAmount,
        //     maxDepositAmount
        // );
        console.log(
            "valid deposit - trancheIndex: %s, lender: %s, depositAmount: %s",
            trancheIndex,
            lender,
            depositAmount
        );
        validCalls[this.deposit.selector]++;
        vm.startPrank(lender);
        mockToken.mint(lender, depositAmount);
        mockToken.approve(address(poolSafe), depositAmount);
        tranche.deposit(depositAmount, lender);
        vm.stopPrank();
        if (tranche.balanceOf(lender) >= minRedemptionShares) {
            investedLendersByTranche[trancheIndex].push(lender);
        }
    }

    function addRedemptionRequest(
        uint256 trancheSeed,
        uint256 lenderSeed,
        uint256 shareSeed,
        uint256 timeSeed
    )
        public
        logCall(this.addRedemptionRequest.selector, "addRedemptionRequest")
        advanceTimestamp(timeSeed)
    {
        console.log("addRedemptionRequest starts......");
        uint256 trancheIndex = _boundNew(trancheSeed, 0, tranches.length - 1);
        if (investedLendersByTranche[trancheIndex].length == 0) return;
        TrancheVault tranche = tranches[trancheIndex];
        uint256 lenderIndex = _boundNew(
            lenderSeed,
            0,
            investedLendersByTranche[trancheIndex].length - 1
        );
        address lender = investedLendersByTranche[trancheIndex][lenderIndex];
        uint256 maxRedemptionShares = tranche.balanceOf(lender);
        if (minRedemptionShares > maxRedemptionShares) return;
        uint256 redemptionShares = _boundNew(shareSeed, minRedemptionShares, maxRedemptionShares);
        console.log(
            "shareSeed: %s, minRedemptionShares: %s, maxRedemptionShares: %s",
            shareSeed,
            minRedemptionShares,
            maxRedemptionShares
        );
        console.log(
            "valid addRedemptionRequest - trancheIndex: %s, lender: %s, redemptionShares: %s",
            trancheIndex,
            lender,
            redemptionShares
        );
        validCalls[this.addRedemptionRequest.selector]++;
        vm.startPrank(lender);
        tranche.addRedemptionRequest(redemptionShares);
        vm.stopPrank();
        if (tranche.balanceOf(lender) < minRedemptionShares) {
            _removeItem(investedLendersByTranche[trancheIndex], lenderIndex);
        }
        redeemedLendersByTranche[trancheIndex].push(lender);
    }

    function cancelRedemptionRequest(
        uint256 trancheSeed,
        uint256 lenderSeed,
        uint256 shareSeed,
        uint256 timeSeed
    )
        public
        logCall(this.cancelRedemptionRequest.selector, "cancelRedemptionRequest")
        advanceTimestamp(timeSeed)
    {
        uint256 trancheIndex = _boundNew(trancheSeed, 0, tranches.length - 1);
        // console.log(
        //     "trancheIndex: %s, redeemedLendersByTranche[0].length: %s, redeemedLendersByTranche[1].length: %s",
        //     trancheIndex,
        //     redeemedLendersByTranche[0].length,
        //     redeemedLendersByTranche[1].length
        // );
        if (redeemedLendersByTranche[trancheIndex].length == 0) return;
        TrancheVault tranche = tranches[trancheIndex];
        uint256 lenderIndex = _boundNew(
            lenderSeed,
            0,
            redeemedLendersByTranche[trancheIndex].length - 1
        );
        address lender = redeemedLendersByTranche[trancheIndex][lenderIndex];
        uint256 maxRedemptionShares = tranche.cancellableRedemptionShares(lender);
        if (minRedemptionShares > maxRedemptionShares) return;
        uint256 redemptionShares = _boundNew(shareSeed, minRedemptionShares, maxRedemptionShares);
        console.log(
            "shareSeed: %s, minRedemptionShares: %s, maxRedemptionShares: %s",
            shareSeed,
            minRedemptionShares,
            maxRedemptionShares
        );
        console.log(
            "valid cancelRedemptionRequest - trancheIndex: %s, lender: %s, redemptionShares: %s",
            trancheIndex,
            lender,
            redemptionShares
        );
        validCalls[this.cancelRedemptionRequest.selector]++;
        vm.startPrank(lender);
        tranche.cancelRedemptionRequest(redemptionShares);
        vm.stopPrank();
        maxRedemptionShares = tranche.cancellableRedemptionShares(lender);
        if (maxRedemptionShares < minRedemptionShares) {
            _removeItem(redeemedLendersByTranche[trancheIndex], lenderIndex);
        }
    }

    function disburse(
        uint256 trancheSeed,
        uint256 lenderSeed,
        uint256 timeSeed
    ) public logCall(this.disburse.selector, "disburse") advanceTimestamp(timeSeed) {
        uint256 trancheIndex = _boundNew(trancheSeed, 0, tranches.length - 1);
        if (redeemedLendersByTranche[trancheIndex].length == 0) return;
        TrancheVault tranche = tranches[trancheIndex];
        uint256 lenderIndex = _boundNew(
            lenderSeed,
            0,
            redeemedLendersByTranche[trancheIndex].length - 1
        );
        address lender = redeemedLendersByTranche[trancheIndex][lenderIndex];
        console.log("valid disburse - trancheIndex: %s, lender: %s", trancheIndex, lender);
        validCalls[this.disburse.selector]++;
        vm.startPrank(lender);
        uint256 balanceBefore = mockToken.balanceOf(lender);
        tranche.disburse();
        uint256 withdrawn = mockToken.balanceOf(lender) - balanceBefore;
        lendersWithdrawn[lender][trancheIndex] += withdrawn;
        vm.stopPrank();
        uint256 maxRedemptionShares = tranche.cancellableRedemptionShares(lender);
        if (maxRedemptionShares < minRedemptionShares) {
            uint256 len = redeemedLendersByTranche[trancheIndex].length;
            redeemedLendersByTranche[trancheIndex][lenderIndex] = redeemedLendersByTranche[
                trancheIndex
            ][len - 1];
            redeemedLendersByTranche[trancheIndex].pop();
        }
    }

    function processYieldForLenders(
        uint256 trancheSeed,
        uint256 timeSeed
    )
        public
        logCall(this.processYieldForLenders.selector, "processYieldForLenders")
        advanceTimestamp(timeSeed)
    {
        if (!hasProfit) return;
        uint256 trancheIndex = _boundNew(trancheSeed, 0, tranches.length - 1);
        TrancheVault tranche = tranches[trancheIndex];
        console.log("valid processYieldForLenders - trancheIndex: %s", trancheIndex);
        validCalls[this.processYieldForLenders.selector]++;
        tranche.processYieldForLenders();
        hasProfit = false;
    }

    function drawdown(
        uint256 borrowerSeed,
        uint256 amountSeed,
        uint256 timeSeed
    ) public logCall(this.drawdown.selector, "drawdown") advanceTimestamp(timeSeed) {
        uint256 borrowerIndex = _boundNew(borrowerSeed, 0, borrowers.length - 1);
        address borrower = borrowers[borrowerIndex];
        (CreditRecord memory cr, ) = creditLine.getDueInfo(borrower);
        if (cr.state != CreditState.Approved && cr.state != CreditState.GoodStanding) return;
        if (cr.remainingPeriods == 0) return;
        if (cr.nextDue != 0 && block.timestamp > cr.nextDueDate) return;
        CreditConfig memory cc = creditLineManager.getCreditConfig(
            keccak256(abi.encode(address(creditLine), borrower))
        );
        uint256 maxDrawdownAmount = cc.creditLimit -
            cr.unbilledPrincipal -
            (cr.nextDue - cr.yieldDue);
        uint256 poolAvailableBalance = poolSafe.getAvailableBalanceForPool();
        maxDrawdownAmount = maxDrawdownAmount > poolAvailableBalance
            ? poolAvailableBalance
            : maxDrawdownAmount;
        if (minDrawdownAmount > maxDrawdownAmount) return;
        uint256 drawdownAmount = _boundNew(amountSeed, minDrawdownAmount, maxDrawdownAmount);
        console.log("valid drawdown - borrower: %s, drawdownAmount: %s", borrower, drawdownAmount);
        validCalls[this.drawdown.selector]++;
        vm.startPrank(borrower);
        creditLine.drawdown(borrower, drawdownAmount);
        vm.stopPrank();
        borrowedBorrowers.push(borrower);
        hasProfit = true;
    }

    function makePayment(
        uint256 borrowerSeed,
        uint256 amountSeed,
        uint256 timeSeed
    ) public logCall(this.makePayment.selector, "makePayment") advanceTimestamp(timeSeed) {
        if (borrowedBorrowers.length == 0) return;
        uint256 borrowerIndex = _boundNew(borrowerSeed, 0, borrowedBorrowers.length - 1);
        address borrower = borrowedBorrowers[borrowerIndex];
        (CreditRecord memory cr, ) = creditLine.getDueInfo(borrower);
        if (cr.nextDue == 0 && cr.totalPastDue == 0) return;
        uint256 maxPaymentAmount = creditDueManager.getPayoffAmount(cr);
        uint256 paymentAmount = _boundNew(amountSeed, minPaymentAmount, maxPaymentAmount * 2);
        console.log(
            "valid makePayment - borrower: %s, paymentAmount: %s",
            borrower,
            paymentAmount
        );
        validCalls[this.makePayment.selector]++;
        vm.startPrank(borrower);
        mockToken.mint(borrower, paymentAmount);
        mockToken.approve(address(poolSafe), paymentAmount);
        creditLine.makePayment(borrower, paymentAmount);
        vm.stopPrank();
        if (paymentAmount >= maxPaymentAmount) {
            _removeItem(borrowedBorrowers, borrowerIndex);
        }
        hasProfit = true;
    }

    function refreshCredit(
        uint256 borrowerSeed,
        uint256 timeSeed
    ) public logCall(this.refreshCredit.selector, "refreshCredit") advanceTimestamp(timeSeed) {
        uint256 borrowerIndex = _boundNew(borrowerSeed, 0, borrowers.length - 1);
        address borrower = borrowers[borrowerIndex];
        console.log("valid refreshCredit - borrower: %s", borrower);
        validCalls[this.refreshCredit.selector]++;
        vm.startPrank(borrower);
        creditLineManager.refreshCredit(borrower);
        vm.stopPrank();
    }

    function displayCallsLog() public view {
        console.log("calls: ");
        console.log("--------------------");
        uint256 total;
        console.log("deposit: %s", calls[this.deposit.selector]);
        total += calls[this.deposit.selector];
        console.log("addRedemptionRequest: %s", calls[this.addRedemptionRequest.selector]);
        total += calls[this.addRedemptionRequest.selector];
        console.log("cancelRedemptionRequest: %s", calls[this.cancelRedemptionRequest.selector]);
        total += calls[this.cancelRedemptionRequest.selector];
        console.log("disburse: %s", calls[this.disburse.selector]);
        total += calls[this.disburse.selector];
        console.log("processYieldForLenders: %s", calls[this.processYieldForLenders.selector]);
        total += calls[this.processYieldForLenders.selector];
        console.log("drawdown: %s", calls[this.drawdown.selector]);
        total += calls[this.drawdown.selector];
        console.log("makePayment: %s", calls[this.makePayment.selector]);
        total += calls[this.makePayment.selector];
        console.log("refreshCredit: %s", calls[this.refreshCredit.selector]);
        total += calls[this.refreshCredit.selector];
        console.log("total: %s", total);
        console.log("--------------------");

        console.log("validCalls: ");
        console.log("--------------------");
        total = 0;
        console.log("deposit: %s", validCalls[this.deposit.selector]);
        total += validCalls[this.deposit.selector];
        console.log("addRedemptionRequest: %s", validCalls[this.addRedemptionRequest.selector]);
        total += validCalls[this.addRedemptionRequest.selector];
        console.log(
            "cancelRedemptionRequest: %s",
            validCalls[this.cancelRedemptionRequest.selector]
        );
        total += validCalls[this.cancelRedemptionRequest.selector];
        console.log("disburse: %s", validCalls[this.disburse.selector]);
        total += validCalls[this.disburse.selector];
        console.log(
            "processYieldForLenders: %s",
            validCalls[this.processYieldForLenders.selector]
        );
        total += validCalls[this.processYieldForLenders.selector];
        console.log("drawdown: %s", validCalls[this.drawdown.selector]);
        total += validCalls[this.drawdown.selector];
        console.log("makePayment: %s", validCalls[this.makePayment.selector]);
        total += validCalls[this.makePayment.selector];
        console.log("refreshCredit: %s", validCalls[this.refreshCredit.selector]);
        total += validCalls[this.refreshCredit.selector];
        console.log("total: %s", total);
        console.log("--------------------");
    }

    function boundNew(uint256 x, uint256 min, uint256 max) public pure returns (uint256 result) {
        result = _boundNew(x, min, max);
    }

    function _closeEpoch() internal {
        console.log(
            "close epoch - block.tiemstamp: %s, currentEpochEndTime: %s",
            block.timestamp,
            currentEpochEndTime
        );
        console.log("closeEpoch starts...");
        bool callInvestFee;
        if (hasProfit) {
            console.log("processYieldForLenders starts...");
            tranches[0].processYieldForLenders();
            tranches[1].processYieldForLenders();
            callInvestFee = true;
            console.log("processYieldForLenders done.");
        }
        uint256 seniorAssetsBefore = mockToken.balanceOf(address(tranches[SENIOR_TRANCHE]));
        uint256 juniorAssetsBefore = mockToken.balanceOf(address(tranches[JUNIOR_TRANCHE]));
        epochManager.closeEpoch();
        uint256 seniorAssetsAfter = mockToken.balanceOf(address(tranches[SENIOR_TRANCHE]));
        uint256 juniorAssetsAfter = mockToken.balanceOf(address(tranches[JUNIOR_TRANCHE]));
        if (seniorAssetsAfter > seniorAssetsBefore) {
            amountsTransferredToTranches[SENIOR_TRANCHE] += seniorAssetsAfter - seniorAssetsBefore;
        }
        if (juniorAssetsAfter > juniorAssetsBefore) {
            amountsTransferredToTranches[JUNIOR_TRANCHE] += juniorAssetsAfter - juniorAssetsBefore;
        }
        _updateCurrentEpochEndTime();
        if (callInvestFee) {
            console.log("investFeesInFirstLossCover starts...");
            uint256 fees = poolFeeManager.getAvailableFeesToInvestInFirstLossCover();
            if (fees > minReinvestFees) {
                vm.startPrank(sentinelServiceAccount);
                poolFeeManager.investFeesInFirstLossCover();
                vm.stopPrank();
            }
            console.log("investFeesInFirstLossCover done.");
        }
        console.log("closeEpoch done.");
    }

    function _updateCurrentEpochEndTime() internal {
        EpochManager.CurrentEpoch memory epoch = epochManager.currentEpoch();
        currentEpochEndTime = epoch.endTime;
    }

    function _removeItem(address[] storage array, uint256 index) internal {
        uint256 len = array.length;
        array[index] = array[len - 1];
        array.pop();
    }

    function _toToken(uint256 amount) internal view returns (uint256) {
        return amount * 10 ** decimals;
    }

    function _boundNew(
        uint256 x,
        uint256 min,
        uint256 max
    ) internal pure returns (uint256 result) {
        require(min <= max, "StdUtils bound(uint256,uint256,uint256): Max is less than min.");
        // If x is between min and max, return x directly. This is to ensure that dictionary values
        // do not get shifted if the min is nonzero. More info: https://github.com/foundry-rs/forge-std/issues/188
        if (x >= min && x <= max) return x;

        uint256 size = max - min + 1;

        if (x < min) {
            x = x + min;
        }

        // Otherwise, wrap x into the range [min, max], i.e. the range is inclusive.
        if (x > max) {
            uint256 diff = x - max;
            uint256 rem = diff % size;
            if (rem == 0) return max;
            result = min + rem - 1;
        } else {
            result = x;
        }
    }
}
