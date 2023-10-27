// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {PoolConfig, PoolSettings, LPConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {IEpoch, EpochInfo} from "./interfaces/IEpoch.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {DEFAULT_DECIMALS_FACTOR, JUNIOR_TRANCHE, SENIOR_TRANCHE} from "./SharedDefs.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {Errors} from "./Errors.sol";
import {ICalendar} from "./credit/interfaces/ICalendar.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITrancheVaultLike is IEpoch {
    function totalSupply() external view returns (uint256);
}

/**
 * @title EpochManager
 * @notice EpochManager processes redemption requests at the end of each billing cycle
 */
contract EpochManager is PoolConfigCache, IEpochManager {
    struct CurrentEpoch {
        uint64 id;
        uint64 endTime;
    }

    IPool public pool;
    IPoolSafe public poolSafe;
    ITrancheVaultLike public seniorTranche;
    ITrancheVaultLike public juniorTranche;
    ICalendar public calendar;

    CurrentEpoch internal _currentEpoch;

    // It is used to avoid tiny amount
    // (e.g. 1 amount = 0.0000001 usdc remaining in the pool caused by rounding down in the last epoch) be processed
    uint256 public minAmountToProcessPerEpoch;

    event EpochClosed(
        uint256 epochId,
        uint256 seniorTrancheAssets,
        uint256 seniorTranchePrice,
        uint256 juniorTrancheAssets,
        uint256 juniorTranchePrice,
        uint256 unprocessedAmount
    );
    event NewEpochStarted(uint256 epochId, uint256 endTime);

    /**
     * @notice Syndicates the address of dependent contracts from pool config:
     * PoolSafe, Pool, Senior TrancheVault, Junior TrancheValut, and Calendar.
     */
    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolSafe();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = IPoolSafe(addr);

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

        addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        uint256 decimals = IERC20Metadata(addr).decimals();
        // set minAmountToProcessPerEpoch to 1 token now
        // TODO change this to a configuration parameter?
        minAmountToProcessPerEpoch = 10 ** decimals;
    }

    /**
     * @notice Closes current epoch and handles senior and junior tranche redemption requests.
     * @dev Expects to be called by a cron-like mechanism like autotask,
     * although anyone can call it to trigger epoch closure.
     */
    function closeEpoch() public virtual {
        poolConfig.onlyProtocolAndPoolOn();

        CurrentEpoch memory ce = _currentEpoch;
        if (block.timestamp <= ce.endTime) revert Errors.closeTooSoon();

        // update tranche assets to the current timestamp
        uint96[2] memory tranchesAssets = pool.refreshPool();

        // calculate senior/junior LP token prices
        uint256 seniorPrice = (tranchesAssets[SENIOR_TRANCHE] * DEFAULT_DECIMALS_FACTOR) /
            seniorTranche.totalSupply();
        uint256 juniorPrice = (tranchesAssets[JUNIOR_TRANCHE] * DEFAULT_DECIMALS_FACTOR) /
            juniorTranche.totalSupply();

        // get unprocessed redemption requests
        EpochInfo memory seniorEpoch = seniorTranche.currentEpochInfo();
        EpochInfo memory juniorEpoch = juniorTranche.currentEpochInfo();
        uint256 unprocessedAmount;

        if (seniorEpoch.totalSharesRequested > 0 || juniorEpoch.totalSharesRequested > 0) {
            _processEpoch(tranchesAssets, seniorEpoch, seniorPrice, juniorEpoch, juniorPrice);

            seniorTranche.executeEpoch(seniorEpoch);
            juniorTranche.executeEpoch(juniorEpoch);

            unprocessedAmount =
                (((seniorEpoch.totalSharesRequested - seniorEpoch.totalSharesProcessed) *
                    seniorPrice) +
                    ((juniorEpoch.totalSharesRequested - juniorEpoch.totalSharesProcessed) *
                        juniorPrice)) /
                DEFAULT_DECIMALS_FACTOR;
        }

        pool.updateTranchesAssets(tranchesAssets);

        emit EpochClosed(
            ce.id,
            tranchesAssets[SENIOR_TRANCHE],
            seniorPrice,
            tranchesAssets[JUNIOR_TRANCHE],
            juniorPrice,
            unprocessedAmount
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
            poolSettings.payPeriodInMonths,
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
     * @notice Process previously unprocessed redemption requests
     * @param tranchesAssets tranches assets indexed by SENIOR_ or JUNIOR_TRANCHE, i.e. tranches[0] is the
     * senior tranche assets and tranches[1] is the junior tranche assets
     * @param seniorEpoch unprocessed/partially processed epoch for the senior tranche
     * @param seniorPrice the senior LP token price
     * @param juniorEpoch unprocessed/partially processed epoch for the junior tranche
     * @param juniorPrice the junior LP token price
     * @dev this function is side-effectual and mutates the following incoming params:
     * tranchesAssets: will be updated to reflect the remaining amount of assets in the tranches after fulfilling
     * redemption requests
     * seniorEpochs: will be updated to reflect the latest redemption request states for the senior tranche
     * juniorEpochs: will be updated to reflect the latest redemption request states for the junior tranche
     */
    function _processEpoch(
        uint96[2] memory tranchesAssets,
        EpochInfo memory seniorEpoch,
        uint256 seniorPrice,
        EpochInfo memory juniorEpoch,
        uint256 juniorPrice
    ) internal view {
        // get available underlying token amount
        uint256 availableAmount = poolSafe.getPoolLiquidity();
        if (availableAmount <= minAmountToProcessPerEpoch) return;

        // Process senior tranche redemption requests.
        if (seniorEpoch.totalSharesRequested > 0) {
            availableAmount = _processSeniorRedemptionRequests(
                tranchesAssets,
                seniorPrice,
                seniorEpoch,
                availableAmount
            );

            if (availableAmount == 0) {
                return;
            }
        }

        // Process junior tranche redemption requests.
        LPConfig memory lpConfig = poolConfig.getLPConfig();
        uint256 maxSeniorJuniorRatio = lpConfig.maxSeniorJuniorRatio;
        if (juniorEpoch.totalSharesRequested > 0) {
            availableAmount = _processJuniorRedemptionRequests(
                tranchesAssets,
                juniorPrice,
                maxSeniorJuniorRatio,
                juniorEpoch,
                availableAmount
            );
        }
    }

    /**
     * @notice Processes redemption requests for the senior tranche
     * @param tranchesAssets tranches assets indexed by SENIOR_TRANCHE or JUNIOR_TRANCHE
     * @param lpTokenPrice the price of the senior LP tokens
     * @param epochInfo epoch info for the senior tranche
     * @param availableAmount the total amount available for redemption
     * @dev this function is side-effectual and mutates the following incoming params:
     * tranchesAssets: will be updated to reflect the remaining amount of assets in the senior tranche
     * epochInfo: will be updated to reflect the latest redemption request states for the senior tranche
     */
    function _processSeniorRedemptionRequests(
        uint96[2] memory tranchesAssets,
        uint256 lpTokenPrice,
        EpochInfo memory epochInfo,
        uint256 availableAmount
    ) internal pure returns (uint256 remainingAmount) {
        uint256 sharesToRedeem = epochInfo.totalSharesRequested;
        uint256 redemptionAmount = (sharesToRedeem * lpTokenPrice) / DEFAULT_DECIMALS_FACTOR;
        if (availableAmount < redemptionAmount) {
            redemptionAmount = availableAmount;
            // TODO rounding error?
            sharesToRedeem = (redemptionAmount * DEFAULT_DECIMALS_FACTOR) / lpTokenPrice;
        }
        epochInfo.totalSharesProcessed = uint96(sharesToRedeem);
        epochInfo.totalAmountProcessed = uint96(redemptionAmount);
        availableAmount -= redemptionAmount;

        tranchesAssets[SENIOR_TRANCHE] -= uint96(redemptionAmount);

        remainingAmount = availableAmount;
    }

    /**
     * @notice Processes redemption requests for the junior tranche. When processing junior requests, special care
     * has to be taken to ensure that the max senior : junior ratio is not breached.
     * @param tranchesAssets tranches assets indexed by SENIOR_ or JUNIOR_TRANCHE, i.e. tranches[0] is the
     * senior tranche assets and tranches[1] is the junior tranche assets
     * @param lpTokenPrice the price of the junior LP tokens
     * @param epochInfo the list of epoch infos in each epoch for the junior tranche
     * @param availableAmount the total amount available for redemption
     * @dev this function is side-effectual and mutates the following incoming params:
     * tranchesAssets: will be updated to reflect the remaining amount of assets in the junior tranche
     * epochInfo: will be updated to reflect the latest redemption request states for the senior tranche
     */
    function _processJuniorRedemptionRequests(
        uint96[2] memory tranchesAssets,
        uint256 lpTokenPrice,
        uint256 maxSeniorJuniorRatio,
        EpochInfo memory epochInfo,
        uint256 availableAmount
    ) internal pure returns (uint256 remainingAmount) {
        // Calculate the minimum amount of junior assets required to maintain the senior : junior ratio.
        // Since integer division rounds down, add 1 to minJuniorAmount in order to maintain the ratio.
        uint256 minJuniorAmount = tranchesAssets[SENIOR_TRANCHE] / maxSeniorJuniorRatio;
        if (minJuniorAmount * maxSeniorJuniorRatio < tranchesAssets[SENIOR_TRANCHE])
            minJuniorAmount += 1;

        uint256 maxRedeemableAmount = tranchesAssets[JUNIOR_TRANCHE] > minJuniorAmount
            ? tranchesAssets[JUNIOR_TRANCHE] - minJuniorAmount
            : 0;
        if (maxRedeemableAmount <= 0) return availableAmount;

        uint256 sharesToRedeem = epochInfo.totalSharesRequested;
        uint256 redemptionAmount = (sharesToRedeem * lpTokenPrice) / DEFAULT_DECIMALS_FACTOR;
        if (availableAmount < redemptionAmount) {
            redemptionAmount = availableAmount;
            // TODO rounding error?
            sharesToRedeem = (redemptionAmount * DEFAULT_DECIMALS_FACTOR) / lpTokenPrice;
        }
        if (maxRedeemableAmount < redemptionAmount) {
            redemptionAmount = maxRedeemableAmount;
            sharesToRedeem = (redemptionAmount * DEFAULT_DECIMALS_FACTOR) / lpTokenPrice;
        }

        epochInfo.totalSharesProcessed = uint96(sharesToRedeem);
        epochInfo.totalAmountProcessed = uint96(redemptionAmount);
        availableAmount -= redemptionAmount;
        tranchesAssets[JUNIOR_TRANCHE] -= uint96(redemptionAmount);

        remainingAmount = availableAmount;
    }
}
