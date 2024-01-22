// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig, PoolSettings} from "contracts/common/PoolConfig.sol";
import {TrancheVault} from "contracts/liquidity/TrancheVault.sol";
import {MockToken} from "contracts/common/mock/MockToken.sol";
import {Pool} from "contracts/liquidity/Pool.sol";
import {EpochManager} from "contracts/liquidity/EpochManager.sol";

import {Test} from "forge-std/Test.sol";
import "forge-std/console.sol";

contract InvariantHandler is Test {
    uint256 immutable decimals;
    uint256 immutable minRedemptionShares;

    TrancheVault[] tranches;
    MockToken mockToken;
    Pool pool;
    address poolSafe;
    EpochManager epochManager;

    uint256 minDepositAmount;
    uint256 currentEpochEndTime;

    address[] lenders;
    mapping(uint256 => address[]) investedLendersByTranche;
    mapping(uint256 => address[]) redeemedLendersByTranche;

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
            // console.log(
            //     "close epoch - tiemstamp: %s, currentEpochEndTime: %s",
            //     timestamp,
            //     currentEpochEndTime
            // );
            console.log("closeEpoch starts...");
            epochManager.closeEpoch();
            console.log("closeEpoch done.");
            _updateCurrentEpochEndTime();
            // console.log(
            //     "close epoch - new currentEpochEndTime: %s",
            //     timestamp,
            //     currentEpochEndTime
            // );
        }

        _;

        console.log(
            "after currentEpochEndTime: %s, block.timestamp: %s",
            currentEpochEndTime,
            block.timestamp
        );
    }

    constructor(address _poolConfig, address[] memory _lenders) {
        PoolConfig poolConfig = PoolConfig(_poolConfig);
        tranches.push(TrancheVault(poolConfig.seniorTranche()));
        tranches.push(TrancheVault(poolConfig.juniorTranche()));
        pool = Pool(poolConfig.pool());
        poolSafe = poolConfig.poolSafe();
        mockToken = MockToken(poolConfig.underlyingToken());
        epochManager = EpochManager(poolConfig.epochManager());
        lenders = _lenders;
        minDepositAmount = poolConfig.getPoolSettings().minDepositAmount;
        decimals = mockToken.decimals();
        minRedemptionShares = _toToken(1);

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
        mockToken.approve(poolSafe, depositAmount);
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
            uint256 len = investedLendersByTranche[trancheIndex].length;
            investedLendersByTranche[trancheIndex][lenderIndex] = investedLendersByTranche[
                trancheIndex
            ][len - 1];
            investedLendersByTranche[trancheIndex].pop();
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
            uint256 len = redeemedLendersByTranche[trancheIndex].length;
            redeemedLendersByTranche[trancheIndex][lenderIndex] = redeemedLendersByTranche[
                trancheIndex
            ][len - 1];
            redeemedLendersByTranche[trancheIndex].pop();
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
        tranche.disburse();
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
        uint256 trancheIndex = _boundNew(trancheSeed, 0, tranches.length - 1);
        TrancheVault tranche = tranches[trancheIndex];
        console.log("valid processYieldForLenders - trancheIndex: %s", trancheIndex);
        tranche.processYieldForLenders();
    }

    function displayCallsLog() public {
        console.log("calls: ");
        console.log("--------------------");
        console.log("deposit: %s", calls[this.deposit.selector]);
        console.log("addRedemptionRequest: %s", calls[this.addRedemptionRequest.selector]);
        console.log("cancelRedemptionRequest: %s", calls[this.cancelRedemptionRequest.selector]);
        console.log("disburse: %s", calls[this.disburse.selector]);
        console.log("processYieldForLenders: %s", calls[this.processYieldForLenders.selector]);
        console.log("--------------------");

        console.log("validCalls: ");
        console.log("--------------------");
        console.log("deposit: %s", validCalls[this.deposit.selector]);
        console.log("addRedemptionRequest: %s", validCalls[this.addRedemptionRequest.selector]);
        console.log(
            "cancelRedemptionRequest: %s",
            validCalls[this.cancelRedemptionRequest.selector]
        );
        console.log("disburse: %s", validCalls[this.disburse.selector]);
        console.log("processYieldForLenders: %s", calls[this.processYieldForLenders.selector]);
        console.log("--------------------");
    }

    function boundNew(uint256 x, uint256 min, uint256 max) public pure returns (uint256 result) {
        result = _boundNew(x, min, max);
    }

    function _updateCurrentEpochEndTime() internal returns (uint256) {
        EpochManager.CurrentEpoch memory epoch = epochManager.currentEpoch();
        currentEpochEndTime = epoch.endTime;
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
