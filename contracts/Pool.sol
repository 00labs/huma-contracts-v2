// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {PoolConfig, FirstLossCoverConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {JUNIOR_TRANCHE, SENIOR_TRANCHE} from "./SharedDefs.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolCredit} from "./credit/interfaces/IPoolCredit.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {IProfitEscrow} from "./interfaces/IProfitEscrow.sol";
import "./SharedDefs.sol";

/**
 * @title Pool
 * @notice Pool is a core contract that connects the lender side (via Tranches)
 * and the borrower side (via Credit)
 */
contract Pool is PoolConfigCache, IPool {
    struct TranchesAssets {
        uint96 seniorTotalAssets; // total assets of senior tranche
        uint96 juniorTotalAssets; // total assets of junior tranche
        uint64 lastUpdatedTime; // the updated timestamp of the tranche assets
    }

    struct TranchesLosses {
        uint96 seniorLoss; // total losses of senior tranche
        uint96 juniorLoss; // total losses of junior tranche
    }

    struct ReservedAssetsForFirstLossCover {
        uint96 profit;
        uint96 lossRecovery;
    }

    enum PoolStatus {
        Off,
        On
    }

    IEpochManager public epochManager;
    IFirstLossCover[] internal _firstLossCovers;
    IPoolCredit public credit;
    IPoolFeeManager public feeManager;
    IPoolSafe public poolSafe;
    ITranchesPolicy public tranchesPolicy;

    TranchesAssets public tranchesAssets;
    TranchesLosses public tranchesLosses;

    // Whether the pool is ON or OFF
    PoolStatus internal _status;

    bool public readyForFirstLossCoverWithdrawal;
    mapping(IFirstLossCover => ReservedAssetsForFirstLossCover)
        internal _reservedAssetsForFirstLossCovers;

    event PoolDisabled(address indexed by);
    event PoolEnabled(address indexed by);
    event PoolReadyForFirstLossCoverWithdrawal(address indexed by, bool ready);

    event PoolAssetsRefreshed(
        uint256 refreshedTimestamp,
        uint256 profit,
        uint256 loss,
        uint256 lossRecovery,
        uint256 seniorTotalAssets,
        uint256 juniorTotalAssets,
        uint256 seniorTotalLoss,
        uint256 juniorTotalLoss
    );

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolSafe();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.tranchesPolicy();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        tranchesPolicy = ITranchesPolicy(addr);

        addr = _poolConfig.credit();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        credit = IPoolCredit(addr);

        addr = _poolConfig.poolFeeManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        feeManager = IPoolFeeManager(addr);

        addr = _poolConfig.epochManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        epochManager = IEpochManager(addr);

        address[16] memory covers = _poolConfig.getFirstLossCovers();
        for (uint256 i = 0; i < covers.length; i++) {
            if (covers[i] != address(0)) _firstLossCovers.push(IFirstLossCover(covers[i]));
            else break;
        }
    }

    /**
     * @notice turns on the pool. Only the pool owner or protocol owner can enable a pool.
     */
    function enablePool() external {
        poolConfig.onlyOwnerOrHumaMasterAdmin(msg.sender);
        poolConfig.checkFirstLossCoverRequirementsForAdmin();
        poolConfig.checkLiquidityRequirements();

        epochManager.startNewEpoch();
        _status = PoolStatus.On;
        emit PoolEnabled(msg.sender);
    }

    /**
     * @notice turns off the pool. Any pool operator can do so when they see abnormalities.
     */
    function disablePool() external {
        poolConfig.onlyPoolOperator(msg.sender);
        _status = PoolStatus.Off;
        emit PoolDisabled(msg.sender);
    }

    function setReadyForFirstLossCoverWithdrawal(bool ready) external {
        poolConfig.onlyOwnerOrHumaMasterAdmin(msg.sender);
        readyForFirstLossCoverWithdrawal = ready;
        emit PoolReadyForFirstLossCoverWithdrawal(msg.sender, ready);
    }

    /// Gets the on/off status of the pool
    function isPoolOn() external view returns (bool status) {
        return _status == PoolStatus.On;
    }

    /// @inheritdoc IPool
    function refreshPool() external returns (uint96[2] memory assets) {
        poolConfig.onlyTrancheVaultOrEpochManagerOrPoolFeeManager(msg.sender);
        assets = _refreshPool();
    }

    function _refreshPool() internal returns (uint96[2] memory assets) {
        (uint256 profit, uint256 loss, uint256 lossRecovery) = credit.refreshPnL();

        TranchesAssets memory tempTranchesAssets = tranchesAssets;
        bool lossesUpdated;

        if (profit > 0) {
            assets = _distributeProfit(profit, tempTranchesAssets);
        } else {
            assets = [tempTranchesAssets.seniorTotalAssets, tempTranchesAssets.juniorTotalAssets];
        }

        TranchesLosses memory tempTranchesLosses = tranchesLosses;
        uint96[2] memory losses = [tempTranchesLosses.seniorLoss, tempTranchesLosses.juniorLoss];
        if (loss > 0) {
            (assets, losses) = _distributeLoss(loss, assets, losses);
            lossesUpdated = true;
        }

        if (lossRecovery > 0) {
            (assets, losses) = _distributeLossRecovery(lossRecovery, assets, losses);
            lossesUpdated = true;
        }

        tempTranchesAssets.seniorTotalAssets = assets[SENIOR_TRANCHE];
        tempTranchesAssets.juniorTotalAssets = assets[JUNIOR_TRANCHE];
        tempTranchesAssets.lastUpdatedTime = uint64(block.timestamp);
        tranchesAssets = tempTranchesAssets;

        if (lossesUpdated) {
            tempTranchesLosses.seniorLoss = losses[SENIOR_TRANCHE];
            tempTranchesLosses.juniorLoss = losses[JUNIOR_TRANCHE];
            tranchesLosses = tempTranchesLosses;
        }

        emit PoolAssetsRefreshed(
            block.timestamp,
            profit,
            loss,
            lossRecovery,
            assets[SENIOR_TRANCHE],
            assets[JUNIOR_TRANCHE],
            losses[SENIOR_TRANCHE],
            losses[JUNIOR_TRANCHE]
        );
    }

    /**
     * @notice Pool owner calls this function to add available liquidity of reserved profit and loss recovery in first loss covers
     */
    function syncFirstLossCovers() external {
        poolConfig.onlyPoolOwner(msg.sender);

        uint256 remainingAssets = poolSafe.totalLiquidity();
        uint256 len = _firstLossCovers.length;
        uint256 availableAssets;
        uint256 poolAssets;
        for (uint256 i; i < len && remainingAssets > 0; i++) {
            bool synced = false;
            IFirstLossCover cover = _firstLossCovers[i];
            ReservedAssetsForFirstLossCover
                memory reservedAssets = _reservedAssetsForFirstLossCovers[cover];

            // Recovers loss in the FirstLossCover with available liquidity
            if (reservedAssets.lossRecovery > 0) {
                availableAssets = remainingAssets > reservedAssets.lossRecovery
                    ? reservedAssets.lossRecovery
                    : remainingAssets;
                cover.recoverLoss(availableAssets);
                remainingAssets -= availableAssets;
                reservedAssets.lossRecovery -= uint96(availableAssets);
                synced = true;
            }

            // Adds profit in the FirstLossCover with available liquidity
            if (reservedAssets.profit > 0 && remainingAssets > 0) {
                // Distributes profit to the cover. If there is still room in the cover, this profit
                // is applied towards increasing coverage. The remainder of the profit is distributed to the
                // first loss cover providers.

                // Invests into the cover until it reaches capacity
                if (poolAssets == 0) {
                    uint96[2] memory assets = _refreshPool();
                    poolAssets = assets[SENIOR_TRANCHE] + assets[JUNIOR_TRANCHE];
                }
                uint256 availableCapacity = _getFirstLossCoverAvailableCap(cover, 0, poolAssets);
                if (availableCapacity > 0) {
                    uint256 profitToInvestInCover = reservedAssets.profit > availableCapacity
                        ? availableCapacity
                        : reservedAssets.profit;
                    availableAssets = remainingAssets > profitToInvestInCover
                        ? profitToInvestInCover
                        : remainingAssets;
                    cover.addCoverAssets(availableAssets);
                    remainingAssets -= availableAssets;
                    reservedAssets.profit -= uint96(availableAssets);
                }

                // Distributes the remainder profit to the cover providers
                if (reservedAssets.profit > 0 && remainingAssets > 0) {
                    availableAssets = remainingAssets > reservedAssets.profit
                        ? reservedAssets.profit
                        : remainingAssets;
                    IProfitEscrow profitEscrow = IProfitEscrow(
                        poolConfig.getFirstLossCoverProfitEscrow(address(cover))
                    );
                    profitEscrow.addProfit(availableAssets);
                    remainingAssets -= availableAssets;
                    reservedAssets.profit -= uint96(availableAssets);
                }

                synced = true;
            }

            if (synced) {
                _reservedAssetsForFirstLossCovers[cover] = reservedAssets;
            }
        }
    }

    /**
     * @notice Gets all the reserved assets for first loss covers. PoolSafe uses this function to reserve
     * the balance of first loss covers
     */
    function getReservedAssetsForFirstLossCovers() external view returns (uint256 reservedAssets) {
        uint256 len = _firstLossCovers.length;
        for (uint256 i; i < len; i++) {
            IFirstLossCover cover = _firstLossCovers[i];
            ReservedAssetsForFirstLossCover memory assets = _reservedAssetsForFirstLossCovers[
                cover
            ];
            reservedAssets += assets.profit + assets.lossRecovery;
        }
    }

    function _distributeProfit(
        uint256 profit,
        TranchesAssets memory assets
    ) internal returns (uint96[2] memory newAssets) {
        uint256 poolProfit = feeManager.distributePoolFees(profit);

        if (poolProfit > 0) {
            newAssets = tranchesPolicy.distProfitToTranches(
                poolProfit,
                [assets.seniorTotalAssets, assets.juniorTotalAssets],
                assets.lastUpdatedTime
            );

            // Distribute profit to first loss covers from profits in the junior tranche.
            newAssets[JUNIOR_TRANCHE] = uint96(
                _distributeProfitForFirstLossCovers(
                    newAssets[JUNIOR_TRANCHE] - assets.juniorTotalAssets,
                    assets.juniorTotalAssets
                )
            );
        }
    }

    function _distributeProfitForFirstLossCovers(
        uint256 profit,
        uint256 juniorTotalAssets
    ) internal returns (uint256 newJuniorTotalAssets) {
        if (profit == 0) return juniorTotalAssets;
        (
            uint256 juniorProfit,
            uint256[16] memory profitsForFirstLossCovers
        ) = _calcProfitForFirstLossCovers(profit, juniorTotalAssets);
        uint256 len = _firstLossCovers.length;
        for (uint256 i; i < len && profitsForFirstLossCovers[i] > 0; i++) {
            IFirstLossCover cover = _firstLossCovers[i];
            ReservedAssetsForFirstLossCover
                memory reservedAssets = _reservedAssetsForFirstLossCovers[cover];
            reservedAssets.profit += uint96(profitsForFirstLossCovers[i]);
            _reservedAssetsForFirstLossCovers[cover] = reservedAssets;
        }
        newJuniorTotalAssets = juniorTotalAssets + juniorProfit;
    }

    function _calcProfitForFirstLossCovers(
        uint256 profit,
        uint256 juniorTotalAssets
    ) internal view returns (uint256 juniorProfit, uint256[16] memory profitsForFirstLossCovers) {
        if (profit == 0) return (juniorProfit, profitsForFirstLossCovers);
        uint256 len = _firstLossCovers.length;
        uint256 totalWeight = juniorTotalAssets;
        for (uint256 i; i < len; i++) {
            IFirstLossCover cover = _firstLossCovers[i];
            // We use profitsForFirstLossCovers to store the effective amount of assets of first loss covers so that
            // we don't have to create another array, which helps to save on gas.
            FirstLossCoverConfig memory config = poolConfig.getFirstLossCoverConfig(
                address(cover)
            );
            profitsForFirstLossCovers[i] = cover.totalAssets() * config.riskYieldMultipliers;
            totalWeight += profitsForFirstLossCovers[i];
        }
        juniorProfit = profit;
        for (uint256 i; i < len; i++) {
            profitsForFirstLossCovers[i] = (profit * profitsForFirstLossCovers[i]) / totalWeight;
            // Note that juniorProfit is always positive because `totalWeight` consists both junior assets
            // and risk adjusted assets from each first loss cover. Thus we don't need to check whether
            // `juniorProfit` ever reaches 0.
            juniorProfit -= profitsForFirstLossCovers[i];
        }
    }

    function _distributeLoss(
        uint256 loss,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) internal returns (uint96[2] memory newAssets, uint96[2] memory newLosses) {
        if (loss > 0) {
            uint256 coverCount = _firstLossCovers.length;
            for (uint256 i; i < coverCount && loss > 0; i++) {
                loss = _firstLossCovers[i].coverLoss(loss);
            }

            if (loss > 0) {
                // If there are losses remaining, let the junior and senior tranches cover the losses.
                uint96[2] memory lossesDelta;
                (assets, lossesDelta) = tranchesPolicy.distLossToTranches(loss, assets);

                losses[SENIOR_TRANCHE] += lossesDelta[SENIOR_TRANCHE];
                losses[JUNIOR_TRANCHE] += lossesDelta[JUNIOR_TRANCHE];
            }
        }

        return (assets, losses);
    }

    function _distributeLossRecovery(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) internal returns (uint96[2] memory newAssets, uint96[2] memory newLosses) {
        if (lossRecovery > 0) {
            (lossRecovery, assets, losses) = tranchesPolicy.distLossRecoveryToTranches(
                lossRecovery,
                assets,
                losses
            );

            uint256 len = _firstLossCovers.length;
            uint256 recoveredAmount;
            for (uint256 i = 0; i < len && lossRecovery > 0; i++) {
                IFirstLossCover cover = _firstLossCovers[len - i - 1];
                (lossRecovery, recoveredAmount) = cover.calcLossRecover(lossRecovery);
                ReservedAssetsForFirstLossCover
                    memory reserveAssets = _reservedAssetsForFirstLossCovers[cover];
                reserveAssets.lossRecovery += uint96(recoveredAmount);
                _reservedAssetsForFirstLossCovers[cover] = reserveAssets;
            }
        }

        return (assets, losses);
    }

    function trancheTotalAssets(uint256 index) external view returns (uint256) {
        uint96[2] memory assets = currentTranchesAssets();
        return assets[index];
    }

    function totalAssets() external view returns (uint256) {
        uint96[2] memory assets = currentTranchesAssets();
        return assets[SENIOR_TRANCHE] + assets[JUNIOR_TRANCHE];
    }

    function currentTranchesAssets() public view returns (uint96[2] memory assets) {
        TranchesAssets memory tempTranchesAssets = tranchesAssets;
        if (block.timestamp <= tempTranchesAssets.lastUpdatedTime) {
            // Return the cached asset data if in the same block, so that we don't need to do all the calculations
            // again. Note that it's theoretically impossible for the block timestamp to be smaller than the
            // last updated timestamp. We are adding the < check because strictly equality is frowned upon
            // by the linter.
            return [tempTranchesAssets.seniorTotalAssets, tempTranchesAssets.juniorTotalAssets];
        }

        (uint256 profit, uint256 loss, uint256 lossRecovery) = credit.getAccruedPnL();
        assets[SENIOR_TRANCHE] = tempTranchesAssets.seniorTotalAssets;
        assets[JUNIOR_TRANCHE] = tempTranchesAssets.juniorTotalAssets;

        if (profit > 0) {
            assets = _calcProfitDistributions(profit, tempTranchesAssets);
        }

        TranchesLosses memory tempTranchesLosses = tranchesLosses;
        uint96[2] memory losses = [tempTranchesLosses.seniorLoss, tempTranchesLosses.juniorLoss];

        if (loss > 0) {
            (assets, losses) = _calcLossDistributions(loss, assets, losses);
        }

        if (lossRecovery > 0) {
            (assets, losses) = _calcLossRecoveryDistributions(lossRecovery, assets, losses);
        }

        return assets;
    }

    function _calcProfitDistributions(
        uint256 profit,
        TranchesAssets memory assets
    ) internal view returns (uint96[2] memory newAssets) {
        uint256 poolProfit = feeManager.calcPlatformFeeDistribution(profit);
        if (poolProfit > 0) {
            newAssets = tranchesPolicy.distProfitToTranches(
                poolProfit,
                [assets.seniorTotalAssets, assets.juniorTotalAssets],
                assets.lastUpdatedTime
            );

            uint256 juniorProfit = newAssets[JUNIOR_TRANCHE] - assets.juniorTotalAssets;
            (juniorProfit, ) = _calcProfitForFirstLossCovers(
                juniorProfit,
                assets.juniorTotalAssets
            );
            newAssets[JUNIOR_TRANCHE] = uint96(assets.juniorTotalAssets + juniorProfit);
        }
    }

    function _calcLossDistributions(
        uint256 loss,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) internal view returns (uint96[2] memory newAssets, uint96[2] memory newLosses) {
        if (loss > 0) {
            // First loss cover
            uint256 coverCount = _firstLossCovers.length;
            for (uint256 i; i < coverCount && loss > 0; i++) {
                IFirstLossCover cover = _firstLossCovers[i];
                loss = cover.calcLossCover(loss);
            }
            uint96[2] memory lossesDelta;
            (assets, lossesDelta) = tranchesPolicy.distLossToTranches(loss, assets);

            losses[SENIOR_TRANCHE] += lossesDelta[SENIOR_TRANCHE];
            losses[JUNIOR_TRANCHE] += lossesDelta[JUNIOR_TRANCHE];
        }

        return (assets, losses);
    }

    function _calcLossRecoveryDistributions(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) internal view returns (uint96[2] memory newAssets, uint96[2] memory newLosses) {
        if (lossRecovery > 0) {
            (lossRecovery, assets, losses) = tranchesPolicy.distLossRecoveryToTranches(
                lossRecovery,
                assets,
                losses
            );

            uint256 len = _firstLossCovers.length;
            for (uint256 i = 0; i < len && lossRecovery > 0; i++) {
                IFirstLossCover cover = _firstLossCovers[len - i - 1];
                (lossRecovery, ) = cover.calcLossRecover(lossRecovery);
            }
        }

        return (assets, losses);
    }

    function submitRedemptionRequest(uint256 amounts) external {
        poolConfig.onlyEpochManager(msg.sender);

        poolSafe.setRedemptionReserve(amounts);

        // :handle redemption request for flex loan
    }

    function updateTranchesAssets(uint96[2] memory assets) external {
        poolConfig.onlyTrancheVaultOrEpochManager(msg.sender);

        TranchesAssets memory tempTranchesAssets = tranchesAssets;
        // This assertion is to ensure that the asset data is up-to-date before any further
        // updates can be made. The asset data can be brought up-to-date usually by calling
        // `refreshPool` before calling this function.
        assert(tempTranchesAssets.lastUpdatedTime == block.timestamp);
        tempTranchesAssets.seniorTotalAssets = assets[SENIOR_TRANCHE];
        tempTranchesAssets.juniorTotalAssets = assets[JUNIOR_TRANCHE];
        tranchesAssets = tempTranchesAssets;
    }

    function getFirstLossCovers() external view returns (IFirstLossCover[] memory) {
        return _firstLossCovers;
    }

    /**
     * @notice Gets the available cap of specified first loss cover including reserved profit and loss recovery
     * PoolFeeManager uses this function to invest available liquidity of fees in first loss cover
     */
    function getFirstLossCoverAvailableCap(
        address coverAddress,
        uint256 poolAssets
    ) external view returns (uint256 availableCap) {
        IFirstLossCover cover = IFirstLossCover(coverAddress);
        ReservedAssetsForFirstLossCover memory reservedAssets = _reservedAssetsForFirstLossCovers[
            cover
        ];
        availableCap = _getFirstLossCoverAvailableCap(
            cover,
            reservedAssets.profit + reservedAssets.lossRecovery,
            poolAssets
        );
    }

    function _getFirstLossCoverAvailableCap(
        IFirstLossCover cover,
        uint256 reservedForCover,
        uint256 poolAssets
    ) internal view returns (uint256 availableCap) {
        FirstLossCoverConfig memory config = poolConfig.getFirstLossCoverConfig(address(cover));
        uint256 currTotalAssets = cover.totalAssets() + reservedForCover;

        uint256 maxCapOfPoolAssets = (poolAssets * config.maxPercentOfPoolValueInBps) /
            HUNDRED_PERCENT_IN_BPS;
        uint256 maxCap = config.liquidityCap > maxCapOfPoolAssets
            ? config.liquidityCap
            : maxCapOfPoolAssets;
        availableCap = maxCap > currTotalAssets ? maxCap - currTotalAssets : 0;
    }
}
