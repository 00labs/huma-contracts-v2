// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseHandler} from "./BaseHandler.sol";
import {PoolConfig} from "contracts/common/PoolConfig.sol";
import {TrancheVault} from "contracts/liquidity/TrancheVault.sol";
import {MockToken} from "contracts/common/mock/MockToken.sol";
import {Pool} from "contracts/liquidity/Pool.sol";
import {PoolFeeManager} from "contracts/liquidity/PoolFeeManager.sol";

import "forge-std/console.sol";

contract LiquidityHandler is BaseHandler {
    uint256 immutable minRedemptionShares;
    uint256 immutable minFeeWithdrawalAmount;

    Pool pool;

    uint256 minDepositAmount;

    address[] lenders;
    mapping(uint256 => address[]) investedLendersByTranche;
    mapping(uint256 => address[]) redeemedLendersByTranche;

    constructor(address[] memory _lenders) BaseHandler() {
        pool = Pool(poolConfig.pool());
        lenders = _lenders;

        minDepositAmount = poolConfig.getPoolSettings().minDepositAmount;
        minRedemptionShares = _toToken(1);
        minFeeWithdrawalAmount = _toToken(1);
    }

    function deposit(
        uint256 trancheSeed,
        uint256 lenderSeed,
        uint256 amountSeed,
        uint256 timeSeed
    ) public logCall(this.deposit.selector) advanceTimestamp(timeSeed) {
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
        baseInvariants.increaseValidCalls(this.deposit.selector);
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
    ) public logCall(this.addRedemptionRequest.selector) advanceTimestamp(timeSeed) {
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
        baseInvariants.increaseValidCalls(this.addRedemptionRequest.selector);
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
    ) public logCall(this.cancelRedemptionRequest.selector) advanceTimestamp(timeSeed) {
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
        baseInvariants.increaseValidCalls(this.cancelRedemptionRequest.selector);
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
    ) public logCall(this.disburse.selector) advanceTimestamp(timeSeed) {
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
        baseInvariants.increaseValidCalls(this.disburse.selector);
        vm.startPrank(lender);
        uint256 balanceBefore = mockToken.balanceOf(lender);
        tranche.disburse();
        uint256 withdrawn = mockToken.balanceOf(lender) - balanceBefore;
        baseInvariants.increaseLenderWithdrawn(lender, trancheIndex, withdrawn);
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
    ) public logCall(this.processYieldForLenders.selector) advanceTimestamp(timeSeed) {
        if (!baseInvariants.hasProfit()) return;
        uint256 trancheIndex = _boundNew(trancheSeed, 0, tranches.length - 1);
        TrancheVault tranche = tranches[trancheIndex];
        console.log("valid processYieldForLenders - trancheIndex: %s", trancheIndex);
        baseInvariants.increaseValidCalls(this.processYieldForLenders.selector);
        tranche.processYieldForLenders();
        baseInvariants.setHasProfit(false);
    }

    function withdrawProtocolFee(
        uint256 amountSeed,
        uint256 timeSeed
    ) public logCall(this.withdrawProtocolFee.selector) advanceTimestamp(timeSeed) {
        if (poolFeeManager.getTotalAvailableFees() == 0) return;
        if (poolFeeManager.getAvailableFeesToInvestInFirstLossCover() > 0) return;
        (uint256 withdrawable, , ) = poolFeeManager.getWithdrawables();
        if (withdrawable < minFeeWithdrawalAmount) return;
        uint256 withdrawalAmount = _boundNew(amountSeed, minFeeWithdrawalAmount, withdrawable);
        console.log("valid withdrawProtocolFee - amountSeed: %s", amountSeed);
        baseInvariants.increaseValidCalls(this.withdrawProtocolFee.selector);
        vm.startPrank(protocolOwner);
        poolFeeManager.withdrawProtocolFee(withdrawalAmount);
        vm.stopPrank();
    }

    function withdrawPoolOwnerFee(
        uint256 amountSeed,
        uint256 timeSeed
    ) public logCall(this.withdrawPoolOwnerFee.selector) advanceTimestamp(timeSeed) {
        if (poolFeeManager.getTotalAvailableFees() == 0) return;
        if (poolFeeManager.getAvailableFeesToInvestInFirstLossCover() > 0) return;
        (, uint256 withdrawable, ) = poolFeeManager.getWithdrawables();
        if (withdrawable < minFeeWithdrawalAmount) return;
        uint256 withdrawalAmount = _boundNew(amountSeed, minFeeWithdrawalAmount, withdrawable);
        console.log("valid withdrawPoolOwnerFee - amountSeed: %s", amountSeed);
        baseInvariants.increaseValidCalls(this.withdrawPoolOwnerFee.selector);
        vm.startPrank(poolOwnerTreasury);
        poolFeeManager.withdrawPoolOwnerFee(withdrawalAmount);
        vm.stopPrank();
    }

    function withdrawEAFee(
        uint256 amountSeed,
        uint256 timeSeed
    ) public logCall(this.withdrawEAFee.selector) advanceTimestamp(timeSeed) {
        if (poolFeeManager.getTotalAvailableFees() == 0) return;
        if (poolFeeManager.getAvailableFeesToInvestInFirstLossCover() > 0) return;
        (, , uint256 withdrawable) = poolFeeManager.getWithdrawables();
        if (withdrawable < minFeeWithdrawalAmount) return;
        uint256 withdrawalAmount = _boundNew(amountSeed, minFeeWithdrawalAmount, withdrawable);
        console.log("valid withdrawEAFee - amountSeed: %s", amountSeed);
        baseInvariants.increaseValidCalls(this.withdrawEAFee.selector);
        vm.startPrank(evaluationAgent);
        poolFeeManager.withdrawEAFee(withdrawalAmount);
        vm.stopPrank();
    }
}
