// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {PoolConfig, LPConfig, PoolSettings} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {IEpoch, EpochInfo} from "./interfaces/IEpoch.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import "./SharedDefs.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {Errors} from "./Errors.sol";
import {ICalendar} from "./credit/interfaces/ICalendar.sol";

import "hardhat/console.sol";

interface ITrancheVaultLike is IEpoch {
    function totalSupply() external view returns (uint256);
}

contract EpochManager is PoolConfigCache, IEpochManager {
    struct TrancheProcessedResult {
        uint256 count;
        uint256 shares;
        uint256 amounts;
    }

    struct EpochsRange {
        uint256 startIndex;
        uint256 length;
    }

    struct CurrentEpoch {
        uint64 id;
        uint64 endTime;
    }

    IPool public pool;
    IPoolVault public poolVault;
    ITrancheVaultLike public seniorTranche;
    ITrancheVaultLike public juniorTranche;
    ICalendar public calendar;

    CurrentEpoch internal _currentEpoch;

    event EpochClosed(
        uint256 epochId,
        uint256 seniorTrancheAssets,
        uint256 seniorTranchePrice,
        uint256 juniorTrancheAssets,
        uint256 juniorTranchePrice,
        uint256 unprocessedAmount
    );
    event NewEpochStarted(uint256 epochId, uint256 endTime);

    constructor(address poolConfigAddress) PoolConfigCache(poolConfigAddress) {}

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);

        addr = _poolConfig.seniorTranche();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        seniorTranche = ITrancheVaultLike(addr);

        addr = _poolConfig.juniorTranche();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        juniorTranche = ITrancheVaultLike(addr);

        addr = _poolConfig.calendar();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        calendar = ICalendar(addr);
    }

    /**
     * @notice Closes current epoch and handle senior tranch orders and junior tranch orders,
     * anyone can call it, an auto task calls it by default.
     */
    function closeEpoch() public virtual {
        poolConfig.onlyProtocolAndPoolOn();

        CurrentEpoch memory ce = _currentEpoch;
        if (block.timestamp <= ce.endTime) revert Errors.closeTooSoon();

        // update tranches assets to current timestamp
        uint96[2] memory tranches = pool.refreshPool();

        // calculate senior/junior token price
        uint256 seniorPrice = (tranches[SENIOR_TRANCHE_INDEX] * DEFAULT_DECIMALS_FACTOR) /
            seniorTranche.totalSupply();
        uint256 juniorPrice = (tranches[JUNIOR_TRANCHE_INDEX] * DEFAULT_DECIMALS_FACTOR) /
            juniorTranche.totalSupply();

        // get unprocessed withdrawal requests
        EpochInfo[] memory seniorEpochs = seniorTranche.unprocessedEpochInfos();
        EpochInfo[] memory juniorEpochs = juniorTranche.unprocessedEpochInfos();

        (
            TrancheProcessedResult memory seniorResult,
            TrancheProcessedResult memory juniorResult
        ) = _executeEpoch(tranches, seniorEpochs, seniorPrice, juniorEpochs, juniorPrice);

        EpochInfo[] memory processedEpochs;
        if (seniorResult.count > 0) {
            processedEpochs = new EpochInfo[](seniorResult.count);
            for (uint256 i; i < seniorResult.count; i++) {
                processedEpochs[i] = seniorEpochs[i];
            }
            seniorTranche.processEpochs(
                processedEpochs,
                seniorResult.shares,
                seniorResult.amounts
            );
        }

        if (juniorResult.count > 0) {
            processedEpochs = new EpochInfo[](juniorResult.count);
            for (uint256 i; i < juniorResult.count; i++) {
                processedEpochs[i] = juniorEpochs[i];
            }
            juniorTranche.processEpochs(
                processedEpochs,
                juniorResult.shares,
                juniorResult.amounts
            );
        }

        pool.updateTranchesAssets(tranches);

        uint256 unprocessedShares;
        if (seniorResult.count > 0) {
            unprocessedShares =
                seniorEpochs[seniorResult.count - 1].totalShareRequested -
                seniorEpochs[seniorResult.count - 1].totalShareProcessed;
        }
        for (uint256 i = seniorResult.count; i < seniorEpochs.length; i++) {
            EpochInfo memory epoch = seniorEpochs[i];
            unprocessedShares += epoch.totalShareRequested - epoch.totalShareProcessed;
        }
        uint256 unprocessedAmounts = (unprocessedShares * seniorPrice) / DEFAULT_DECIMALS_FACTOR;

        unprocessedShares = 0;
        if (juniorResult.count > 0) {
            unprocessedShares =
                juniorEpochs[juniorResult.count - 1].totalShareRequested -
                juniorEpochs[juniorResult.count - 1].totalShareProcessed;
        }
        for (uint256 i = juniorResult.count; i < juniorEpochs.length; i++) {
            EpochInfo memory epoch = juniorEpochs[i];
            unprocessedShares += epoch.totalShareRequested - epoch.totalShareProcessed;
        }
        unprocessedAmounts += (unprocessedShares * juniorPrice) / DEFAULT_DECIMALS_FACTOR;

        pool.submitRedemptionRequest(unprocessedAmounts);

        console.log(
            "id: %s, juniorTotalAssets: %s, seniorTotalAssets: %s",
            uint256(ce.id),
            tranches[JUNIOR_TRANCHE_INDEX],
            tranches[SENIOR_TRANCHE_INDEX]
        );

        console.log(
            "seniorPrice: %s, juniorPrice: %s, unprocessedAmounts: %s",
            seniorPrice,
            juniorPrice,
            unprocessedAmounts
        );

        emit EpochClosed(
            ce.id,
            tranches[SENIOR_TRANCHE_INDEX],
            seniorPrice,
            tranches[JUNIOR_TRANCHE_INDEX],
            juniorPrice,
            unprocessedAmounts
        );
        _createNextEpoch(ce);
    }

    function startNewEpoch() external {
        poolConfig.onlyPool(msg.sender);

        CurrentEpoch memory ce = _currentEpoch;
        ce.endTime = 0;
        _createNextEpoch(ce);
    }

    function _createNextEpoch(CurrentEpoch memory epoch) internal {
        epoch.id += 1;
        PoolSettings memory poolSettings = poolConfig.getPoolSettings();
        (uint256 nextEndTime, ) = calendar.getNextDueDate(
            poolSettings.calendarUnit,
            poolSettings.epochWindowInCalendarUnit,
            epoch.endTime
        );
        epoch.endTime = uint64(nextEndTime);
        _currentEpoch = epoch;

        emit NewEpochStarted(epoch.id, epoch.endTime);
    }

    function currentEpochId() external view returns (uint256) {
        return _currentEpoch.id;
    }

    function currentEpoch() external view returns (CurrentEpoch memory) {
        return _currentEpoch;
    }

    /**
     * @notice Process tranches orders
     * @param tranches tranches assets
     * tranches[0] - senior tranche assets
     * tranches[1] - junior tranche assets
     */
    function _executeEpoch(
        uint96[2] memory tranches,
        EpochInfo[] memory seniorEpochs,
        uint256 seniorPrice,
        EpochInfo[] memory juniorEpochs,
        uint256 juniorPrice
    )
        internal
        view
        virtual
        returns (
            TrancheProcessedResult memory seniorResult,
            TrancheProcessedResult memory juniorResult
        )
    {
        // get available underlying token amount
        uint256 availableAmount = poolVault.totalAssets();
        console.log("availableAmount: %s", availableAmount);
        if (availableAmount <= 0) return (seniorResult, juniorResult);

        LPConfig memory lpConfig = poolConfig.getLPConfig();
        uint256 flexPeriod = lpConfig.flexCallWindowInCalendarUnit;
        uint256 maxEpochId = _currentEpoch.id;

        // process mature senior withdrawal requests
        uint256 availableCount = seniorEpochs.length;
        if (flexPeriod > 0) {
            // get mature senior epochs count
            uint256 maxMatureEpochId = maxEpochId - flexPeriod;
            for (uint256 i; i < seniorEpochs.length; i++) {
                if (seniorEpochs[i].epochId <= maxMatureEpochId) {
                    availableCount += 1;
                } else {
                    break;
                }
            }
        }
        availableAmount = _processSeniorEpochs(
            tranches,
            seniorPrice,
            seniorEpochs,
            EpochsRange(0, availableCount),
            availableAmount,
            seniorResult
        );
        console.log("availableAmount: %s", availableAmount);
        console.log(
            "seniorResult.count: %s, seniorResult.shares: %s, seniorResult.amounts: %s",
            seniorResult.count,
            seniorResult.shares,
            seniorResult.amounts
        );
        if (availableAmount <= 0) {
            return (seniorResult, juniorResult);
        }

        // process mature junior withdrawal requests
        availableCount = juniorEpochs.length;
        if (flexPeriod > 0) {
            // get mature junior epochs count
            uint256 maxMatureEpochId = maxEpochId - flexPeriod;
            for (uint256 i; i < juniorEpochs.length; i++) {
                if (juniorEpochs[i].epochId <= maxMatureEpochId) {
                    availableCount += 1;
                } else {
                    break;
                }
            }
        }
        console.log("availableCount: %s", availableCount);

        uint256 maxSeniorJuniorRatio = lpConfig.maxSeniorJuniorRatio;
        availableAmount = _processJuniorEpochs(
            tranches,
            juniorPrice,
            maxSeniorJuniorRatio,
            juniorEpochs,
            EpochsRange(0, availableCount),
            availableAmount,
            juniorResult
        );
        console.log("availableAmount: %s", availableAmount);
        console.log(
            "juniorResult.count: %s, juniorResult.shares: %s, juniorResult.amounts: %s",
            juniorResult.count,
            juniorResult.shares,
            juniorResult.amounts
        );
        if (availableAmount <= 0 || flexPeriod <= 0) {
            return (seniorResult, juniorResult);
        }

        // process immature senior withdrawal requests
        availableCount = seniorEpochs.length - seniorResult.count;
        if (availableCount > 0) {
            availableAmount = _processSeniorEpochs(
                tranches,
                seniorPrice,
                seniorEpochs,
                EpochsRange(seniorResult.count, availableCount),
                availableAmount,
                seniorResult
            );
            if (availableAmount <= 0) {
                return (seniorResult, juniorResult);
            }
        }

        // process immature junior withdrawal requests
        availableCount = juniorEpochs.length - juniorResult.count;
        if (availableCount > 0) {
            availableAmount = _processJuniorEpochs(
                tranches,
                juniorPrice,
                maxSeniorJuniorRatio,
                juniorEpochs,
                EpochsRange(juniorResult.count, availableCount),
                availableAmount,
                juniorResult
            );
            if (availableAmount <= 0) {
                return (seniorResult, juniorResult);
            }
        }
    }

    function _processSeniorEpochs(
        uint96[2] memory tranches,
        uint256 price,
        EpochInfo[] memory epochs,
        EpochsRange memory epochsRange,
        uint256 availableAmount,
        TrancheProcessedResult memory trancheResult
    ) internal view returns (uint256 remainingAmount) {
        for (uint256 i = epochsRange.startIndex; i < epochsRange.length; i++) {
            EpochInfo memory epochInfo = epochs[i];
            console.log(
                "epochInfo.epochId: %s, epochInfo.totalShareRequested: %s, epochInfo.totalShareProcessed: %s",
                uint256(epochInfo.epochId),
                uint256(epochInfo.totalShareRequested),
                uint256(epochInfo.totalShareProcessed)
            );
            console.log(
                "epochInfo.epochId: %s, epochInfo.totalAmountProcessed: %s",
                uint256(epochInfo.epochId),
                uint256(epochInfo.totalAmountProcessed)
            );
            uint256 shares = epochInfo.totalShareRequested - epochInfo.totalShareProcessed;
            uint256 amounts = (shares * price) / DEFAULT_DECIMALS_FACTOR;
            if (availableAmount < amounts) {
                amounts = availableAmount;
                shares = (amounts * DEFAULT_DECIMALS_FACTOR) / price;
            }
            epochInfo.totalShareProcessed += uint96(shares);
            epochInfo.totalAmountProcessed += uint96(amounts);
            availableAmount -= amounts;

            console.log(
                "epochInfo.totalShareProcessed: %s, epochInfo.totalAmountProcessed: %s",
                uint256(epochInfo.totalShareProcessed),
                uint256(epochInfo.totalAmountProcessed)
            );

            trancheResult.count += 1;
            trancheResult.shares += shares;
            trancheResult.amounts += amounts;

            console.log(
                "trancheResult.count: %s, trancheResult.shares: %s, trancheResult.amounts: %s",
                uint256(trancheResult.count),
                uint256(trancheResult.shares),
                uint256(trancheResult.amounts)
            );

            if (availableAmount == 0) break;
        }

        remainingAmount = availableAmount;
        tranches[SENIOR_TRANCHE_INDEX] -= uint96(trancheResult.amounts);
    }

    function _processJuniorEpochs(
        uint96[2] memory tranches,
        uint256 price,
        uint256 maxSeniorJuniorRatio,
        EpochInfo[] memory epochs,
        EpochsRange memory epochsRange,
        uint256 availableAmount,
        TrancheProcessedResult memory trancheResult
    ) internal pure returns (uint256 remainingAmount) {
        // Round up to meet maxSeniorJuniorRatio
        uint256 minJuniorAmounts = tranches[SENIOR_TRANCHE_INDEX] / maxSeniorJuniorRatio + 1;
        uint256 maxAmounts = tranches[JUNIOR_TRANCHE_INDEX] > minJuniorAmounts
            ? tranches[JUNIOR_TRANCHE_INDEX] - minJuniorAmounts
            : 0;

        if (maxAmounts <= 0) return availableAmount;

        for (uint256 i = epochsRange.startIndex; i < epochsRange.length; i++) {
            EpochInfo memory epochInfo = epochs[i];
            uint256 shares = epochInfo.totalShareRequested - epochInfo.totalShareProcessed;
            uint256 amounts = (shares * price) / DEFAULT_DECIMALS_FACTOR;
            if (availableAmount < amounts) {
                amounts = availableAmount;
            }
            if (maxAmounts < amounts) {
                amounts = maxAmounts;
            }

            shares = (amounts * DEFAULT_DECIMALS_FACTOR) / price;
            epochInfo.totalShareProcessed += uint96(shares);
            epochInfo.totalAmountProcessed += uint96(amounts);
            availableAmount -= amounts;
            maxAmounts -= amounts;
            tranches[JUNIOR_TRANCHE_INDEX] -= uint96(amounts);

            trancheResult.count += 1;
            trancheResult.shares += shares;
            trancheResult.amounts += amounts;

            if (availableAmount == 0 || maxAmounts == 0) break;
        }

        remainingAmount = availableAmount;
    }
}
