// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {IPlatformFeeManager} from "./interfaces/IPlatformFeeManager.sol";
import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {IPoolCredit} from "./credit/interfaces/IPoolCredit.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import "./SharedDefs.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {Errors} from "./Errors.sol";

contract Pool is PoolConfigCache, IPool {
    struct TranchesAssets {
        uint96 seniorTotalAssets; // total assets of senior tranche
        uint96 juniorTotalAssets; // total assets of junior tranche
        uint64 lastUpdatedTime; // the updated timestamp of seniorTotalAssets and juniorTotalAssets
    }

    struct TranchesLosses {
        uint96 seniorLoss; // total losses of senior tranche
        uint96 juniorLoss; // total losses of junior tranche
    }

    IPoolVault public poolVault;
    ITranchesPolicy public tranchesPolicy;
    IFirstLossCover[] public firstLossCovers;
    IFirstLossCover public poolOwnerOrEAFirstLossCover;
    IPoolCredit public credit;
    IPlatformFeeManager public feeManager;
    IEpochManager public epochManager;

    TranchesAssets public tranchesAssets;
    TranchesLosses public tranchesLosses;

    enum PoolStatus {
        Off,
        On
    }

    // Whether the pool is ON or OFF
    PoolStatus internal _status;

    event PoolDisabled(address indexed by);
    event PoolEnabled(address indexed by);

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
        address addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = _poolConfig.tranchesPolicy();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        tranchesPolicy = ITranchesPolicy(addr);

        addr = _poolConfig.credit();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        credit = IPoolCredit(addr);

        addr = _poolConfig.platformFeeManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        feeManager = IPlatformFeeManager(addr);

        addr = _poolConfig.poolOwnerOrEAFirstLossCover();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolOwnerOrEAFirstLossCover = IFirstLossCover(addr);

        addr = _poolConfig.epochManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        epochManager = IEpochManager(addr);

        address[] memory covers = _poolConfig.getFirstLossCovers();
        for (uint256 i = 0; i < covers.length; i++) {
            firstLossCovers[i] = IFirstLossCover(covers[i]);
        }
    }

    /**
     * @notice turns on the pool. Only the pool owner or protocol owner can enable a pool.
     */
    function enablePool() external {
        poolConfig.onlyOwnerOrHumaMasterAdmin(msg.sender);
        poolConfig.checkFirstLossCoverRequirement();

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

    /// Gets the on/off status of the pool
    function isPoolOn() external view returns (bool status) {
        if (_status == PoolStatus.On) return true;
        else return false;
    }

    function refreshPool() external returns (uint96[2] memory assets) {
        poolConfig.onlyTrancheVaultOrEpochManager(msg.sender);

        (uint256 profit, uint256 loss, uint256 lossRecovery) = credit.refreshPnL();

        TranchesAssets memory ta = tranchesAssets;
        bool lossesUpdated;

        if (profit > 0) {
            assets = _distributeProfit(profit, ta);
        } else {
            assets = [ta.seniorTotalAssets, ta.juniorTotalAssets];
        }

        TranchesLosses memory tl = tranchesLosses;
        uint96[2] memory losses = [tl.seniorLoss, tl.juniorLoss];
        if (loss > 0) {
            (assets, losses) = _distributeLoss(loss, assets, losses);
            lossesUpdated = true;
        }

        if (lossRecovery > 0) {
            (assets, losses) = _distributeLossRecovery(lossRecovery, assets, losses);
            lossesUpdated = true;
        }

        ta.seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
        ta.juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
        ta.lastUpdatedTime = uint64(block.timestamp);
        tranchesAssets = ta;

        if (lossesUpdated) {
            tl.seniorLoss = losses[SENIOR_TRANCHE_INDEX];
            tl.juniorLoss = losses[JUNIOR_TRANCHE_INDEX];
            tranchesLosses = tl;
        }

        emit PoolAssetsRefreshed(
            block.timestamp,
            profit,
            loss,
            lossRecovery,
            assets[SENIOR_TRANCHE_INDEX],
            assets[JUNIOR_TRANCHE_INDEX],
            losses[SENIOR_TRANCHE_INDEX],
            losses[JUNIOR_TRANCHE_INDEX]
        );
    }

    function _distributeProfit(
        uint256 profit,
        TranchesAssets memory ta
    ) internal returns (uint96[2] memory newAssets) {
        uint256 poolProfit = feeManager.distributePlatformFees(profit);
        newAssets = [ta.seniorTotalAssets, ta.juniorTotalAssets];

        if (poolProfit > 0) {
            newAssets = tranchesPolicy.calcTranchesAssetsForProfit(
                poolProfit,
                newAssets,
                ta.lastUpdatedTime
            );
        }
    }

    function _distributeLoss(
        uint256 loss,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) internal returns (uint96[2] memory newAssets, uint96[2] memory newLosses) {
        if (loss > 0) {
            // First loss cover
            uint256 poolAssets = assets[SENIOR_TRANCHE_INDEX] + assets[JUNIOR_TRANCHE_INDEX];
            for (uint256 i; i < firstLossCovers.length && loss > 0; i++) {
                IFirstLossCover cover = firstLossCovers[i];
                loss = cover.coverLoss(poolAssets, loss);
            }

            if (loss > 0) {
                uint96[2] memory lossesDelta;
                (assets, lossesDelta) = tranchesPolicy.calcTranchesAssetsForLoss(loss, assets);

                losses[SENIOR_TRANCHE_INDEX] += lossesDelta[SENIOR_TRANCHE_INDEX];
                losses[JUNIOR_TRANCHE_INDEX] += lossesDelta[JUNIOR_TRANCHE_INDEX];
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
            (lossRecovery, assets, losses) = tranchesPolicy.calcTranchesAssetsForLossRecovery(
                lossRecovery,
                assets,
                losses
            );

            uint256 len = firstLossCovers.length;
            for (uint256 i = 0; i < len && lossRecovery > 0; i++) {
                IFirstLossCover cover = firstLossCovers[len - i - 1];
                lossRecovery = cover.recoverLoss(lossRecovery);
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
        return assets[SENIOR_TRANCHE_INDEX] + assets[JUNIOR_TRANCHE_INDEX];
    }

    function currentTranchesAssets() public view returns (uint96[2] memory assets) {
        TranchesAssets memory ta = tranchesAssets;
        if (block.timestamp <= ta.lastUpdatedTime) {
            return [ta.seniorTotalAssets, ta.juniorTotalAssets];
        }

        (uint256 profit, uint256 loss, uint256 lossRecovery) = credit.getAccruedPnL();
        assets[SENIOR_TRANCHE_INDEX] = ta.seniorTotalAssets;
        assets[JUNIOR_TRANCHE_INDEX] = ta.juniorTotalAssets;

        if (profit > 0) {
            assets = _calcProfitDistributions(profit, ta);
        }

        TranchesLosses memory tl = tranchesLosses;
        uint96[2] memory losses = [tl.seniorLoss, tl.juniorLoss];

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
        TranchesAssets memory ta
    ) internal view returns (uint96[2] memory newAssets) {
        uint256 poolProfit = feeManager.calcPlatformFeeDistribution(profit);
        newAssets = [ta.seniorTotalAssets, ta.juniorTotalAssets];
        if (poolProfit > 0) {
            newAssets = tranchesPolicy.calcTranchesAssetsForProfit(
                poolProfit,
                newAssets,
                ta.lastUpdatedTime
            );
        }
    }

    function _calcLossDistributions(
        uint256 loss,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) internal view returns (uint96[2] memory newAssets, uint96[2] memory newLosses) {
        if (loss > 0) {
            // First loss cover
            uint256 poolAssets = assets[SENIOR_TRANCHE_INDEX] + assets[JUNIOR_TRANCHE_INDEX];
            for (uint256 i; i < firstLossCovers.length && loss > 0; i++) {
                IFirstLossCover cover = firstLossCovers[i];
                loss = cover.calcLossCover(poolAssets, loss);
            }
            uint96[2] memory lossesDelta;
            (assets, lossesDelta) = tranchesPolicy.calcTranchesAssetsForLoss(loss, assets);

            losses[SENIOR_TRANCHE_INDEX] += lossesDelta[SENIOR_TRANCHE_INDEX];
            losses[JUNIOR_TRANCHE_INDEX] += lossesDelta[JUNIOR_TRANCHE_INDEX];
        }

        return (assets, losses);
    }

    function _calcLossRecoveryDistributions(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) internal view returns (uint96[2] memory newAssets, uint96[2] memory newLosses) {
        if (lossRecovery > 0) {
            (lossRecovery, assets, losses) = tranchesPolicy.calcTranchesAssetsForLossRecovery(
                lossRecovery,
                assets,
                losses
            );

            uint256 len = firstLossCovers.length;
            for (uint256 i = 0; i < len && lossRecovery > 0; i++) {
                IFirstLossCover cover = firstLossCovers[len - i - 1];
                lossRecovery = cover.calcLossRecover(lossRecovery);
            }
        }

        return (assets, losses);
    }

    function submitRedemptionRequest(uint256 amounts) external {
        poolConfig.onlyEpochManager(msg.sender);

        poolVault.setRedemptionReserve(amounts);

        // :handle redemption request for flex loan
    }

    function updateTranchesAssets(uint96[2] memory assets) external {
        poolConfig.onlyTrancheVaultOrEpochManager(msg.sender);

        TranchesAssets memory ta = tranchesAssets;
        ta.seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
        ta.juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
        assert(ta.lastUpdatedTime == block.timestamp);
        tranchesAssets = ta;
    }
}
