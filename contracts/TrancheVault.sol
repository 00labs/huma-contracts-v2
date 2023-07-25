// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "./SharedDefs.sol";
import {IERC20MetadataUpgradeable, ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {TrancheVaultStorage} from "./TrancheVaultStorage.sol";
import {IEpoch, EpochInfo} from "./interfaces/IEpoch.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {Errors} from "./Errors.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";

contract TrancheVault is ERC20Upgradeable, TrancheVaultStorage, IEpoch {
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name,
        string memory symbol,
        PoolConfig _poolConfig,
        uint8 seniorTrancheOrJuniorTranche
    ) external initializer {
        __ERC20_init(name, symbol);

        poolConfig = _poolConfig;
        address underlyingToken = _poolConfig.underlyingToken();
        if (underlyingToken == address(0)) revert Errors.zeroAddressProvided();
        _decimals = IERC20MetadataUpgradeable(underlyingToken).decimals();

        address addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);

        addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = _poolConfig.epochManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        epochManager = IEpochManager(addr);

        if (seniorTrancheOrJuniorTranche > 1) revert();
        trancheIndex = seniorTrancheOrJuniorTranche;
    }

    function setPoolConfig(PoolConfig _poolConfig) external {
        poolConfig.onlyPoolOwner(msg.sender);

        poolConfig = _poolConfig;

        address addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);

        addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = _poolConfig.epochManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        epochManager = IEpochManager(addr);
    }

    /**
     * @notice Returns all unprocessed epochs.
     */
    function unprocessedEpochInfos() external view override returns (EpochInfo[] memory result) {
        uint256 len = epochIds.length - currentEpochIdsIndex;
        result = new EpochInfo[](len);
        for (uint256 i; i < len; i++) {
            result[i] = epochMap[epochIds[currentEpochIdsIndex + i]];
        }
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function totalSupply() public view override returns (uint256) {
        return ERC20Upgradeable.totalSupply();
    }

    /**
     * @notice Updates processed epochs
     */
    function closeEpoch(
        EpochInfo[] memory epochsProcessed,
        uint256 sharesProcessed,
        uint256 amountProcessed
    ) external {
        poolConfig.onlyEpochManager(msg.sender);

        uint256 count = epochsProcessed.length;
        EpochInfo memory epoch;
        for (uint256 i; i < count; i++) {
            epoch = epochsProcessed[i];
            epochMap[epoch.epochId] = epoch;
        }

        if (epoch.totalAmountProcessed >= epoch.totalShareRequested) {
            currentEpochIdsIndex += count;
        } else if (count - 1 > 0) {
            currentEpochIdsIndex += count - 1;
        }

        ERC20Upgradeable._burn(address(this), sharesProcessed);

        // withdraw underlying tokens from reserve
        poolVault.withdraw(address(this), amountProcessed);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        if (shares <= 0) {
            revert(); // assets is 0
        }

        // :validate receiver permission

        uint256 cap = poolConfig.getTrancheLiquidityCap(trancheIndex);
        if (assets > cap) {
            revert();
        }
        uint96[2] memory tranches = pool.refreshPool();
        uint256 totalAssets = tranches[trancheIndex];
        if (totalAssets + assets > cap) {
            revert(); // greater than cap
        }

        if (trancheIndex == SENIOR_TRANCHE_INDEX) {
            // validate maxRatio for senior tranche
            // todo fix it
            uint256 maxRatio = 4;
            //uint256 maxRatio = poolConfig.lpConfig().maxSeniorJuniorRatio();
            if (
                ((totalAssets + assets) / tranches[JUNIOR_TRANCHE_INDEX]) *
                    HUNDRED_PERCENT_IN_BPS >
                maxRatio
            ) revert(); // greater than max ratio
        }

        poolVault.deposit(msg.sender, assets);

        shares = _convertToShares(assets, totalAssets);
        ERC20Upgradeable._mint(receiver, shares);

        tranches[trancheIndex] += uint96(assets);
        pool.updateTranchesAssets(tranches);

        // :send an event
    }

    /**
     * @notice Adds Redemption assets(underlying token amount) in current Redemption request
     */
    function addRedemptionRequest(uint256 shares) external {
        if (shares <= 0) {
            revert(); // assets is 0
        }
        uint256 userShares = ERC20Upgradeable.balanceOf(msg.sender);
        if (shares < userShares) {
            revert(); // assets is too big
        }

        // update global epochId array and EpochInfo mapping
        uint256 epochId = epochManager.currentEpochId();
        EpochInfo memory epochInfo = epochMap[epochId];
        if (epochInfo.totalShareRequested > 0) {
            epochInfo.totalShareRequested += uint96(shares);
        } else {
            epochIds.push(epochId);
            epochInfo.epochId = uint64(epochId);
            epochInfo.totalShareRequested = uint96(shares);
        }
        epochMap[epochId] = epochInfo;

        // update user UserRedemptionRequest array
        UserRedemptionRequest[] storage requests = userRedemptionRequests[msg.sender];
        uint256 lastIndex = requests.length - 1;
        UserRedemptionRequest memory request = requests[lastIndex];
        if (request.epochId == epochId) {
            // add assets in current Redemption request
            request.shareRequested += uint96(shares);
            requests[lastIndex] = request;
        } else {
            // no Redemption request, create a new one
            request.epochId = uint64(epochId);
            request.shareRequested = uint96(shares);
            requests.push(request);
        }

        ERC20Upgradeable._transfer(msg.sender, address(this), shares);

        // :send an event
    }

    /**
     * @notice Removes Redemption assets(underlying token amount) from current Redemption request
     */
    function removeRedemptionRequest(uint256 shares) external {
        if (shares <= 0) {
            revert(); // assets is 0
        }

        UserRedemptionRequest[] storage requests = userRedemptionRequests[msg.sender];
        uint256 lastIndex = requests.length - 1;
        UserRedemptionRequest memory request = requests[lastIndex];
        uint256 epochId = epochManager.currentEpochId();
        if (request.epochId < epochId || request.shareRequested < shares) {
            // only remove from current Redemption request
            revert();
        }

        request.shareRequested -= uint96(shares);
        if (request.shareRequested > 0) {
            requests[lastIndex] = request;
        } else {
            delete requests[lastIndex];
        }

        EpochInfo memory epochInfo = epochMap[epochId];
        epochInfo.totalShareRequested -= uint96(shares);
        if (epochInfo.totalShareRequested > 0) {
            epochMap[epochId] = epochInfo;
        } else {
            delete epochMap[epochId];
            lastIndex = epochIds.length - 1;
            assert(epochIds[lastIndex] == epochId);
            delete epochIds[lastIndex];
        }

        ERC20Upgradeable._transfer(address(this), msg.sender, shares);

        // :send an event
    }

    /**
     * @notice Transfers processed underlying tokens to the user
     */
    function disburse(address receiver) external {
        uint256 withdrawable = _updateUserWithdrawable(msg.sender);
        poolVault.withdraw(receiver, withdrawable);

        // :send an event
    }

    /**
     * @notice Returns the withdrawable assets value of the given account
     */
    function withdrawableAssets(address account) external view returns (uint256 assets) {
        (, assets, ) = _getUserWithdrawable(account);
    }

    function removableRedemptionShares(address account) external view returns (uint256 shares) {
        UserRedemptionRequest[] storage requests = userRedemptionRequests[account];
        uint256 lastIndex = requests.length - 1;
        UserRedemptionRequest memory request = requests[lastIndex];
        uint256 epochId = epochManager.currentEpochId();
        if (request.epochId == epochId) {
            UserDisburseInfo memory disburseInfo = userDisburseInfos[account];
            if (
                disburseInfo.requestsIndex == lastIndex && disburseInfo.partialShareProcessed > 0
            ) {
                // shares = 0;
            } else {
                shares = request.shareRequested;
            }
        }
    }

    function totalAssets() public view returns (uint256) {
        return pool.trancheTotalAssets(trancheIndex);
    }

    function convertToShares(uint256 assets) external view returns (uint256 shares) {
        shares = _convertToShares(assets, totalAssets());
    }

    function _convertToShares(
        uint256 assets,
        uint256 totalAssets
    ) internal view returns (uint256 shares) {
        uint256 supply = ERC20Upgradeable.totalSupply();

        return supply == 0 ? assets : (assets * supply) / totalAssets;
    }

    /**
     * @notice Calculates withdrawable amount from the last index of user Redemption request array
     * to current processed user Redemption request
     */
    function _updateUserWithdrawable(address user) internal returns (uint256 withdrableAmount) {
        (
            uint256 burnableShare,
            uint256 amount,
            UserDisburseInfo memory disburseInfo
        ) = _getUserWithdrawable(user);

        userDisburseInfos[user] = disburseInfo;
        if (burnableShare > 0) {
            ERC20Upgradeable._burn(address(this), burnableShare);
        }
        withdrableAmount = amount;
    }

    function _getUserWithdrawable(
        address user
    )
        internal
        view
        returns (
            uint256 burnableShare,
            uint256 withdrableAmount,
            UserDisburseInfo memory disburseInfo
        )
    {
        disburseInfo = userDisburseInfos[user];
        UserRedemptionRequest[] storage requests = userRedemptionRequests[msg.sender];
        uint256 len = epochIds.length;
        uint256 epochIdsIndex = currentEpochIdsIndex;
        uint256 lastEpochId = epochIdsIndex < len
            ? epochIds[epochIdsIndex]
            : epochIds[len - 1] + 1;

        for (uint256 i = disburseInfo.requestsIndex; i < requests.length; i++) {
            UserRedemptionRequest memory request = requests[i];
            if (request.epochId < lastEpochId) {
                // fully processed
                EpochInfo memory epoch = epochMap[request.epochId];
                uint256 shareProcessed = (request.shareRequested * epoch.totalShareProcessed) /
                    epoch.totalShareRequested;
                uint256 amountProcessed = (request.shareRequested * epoch.totalAmountProcessed) /
                    epoch.totalShareRequested;
                if (disburseInfo.partialShareProcessed > 0) {
                    shareProcessed -= disburseInfo.partialShareProcessed;
                    amountProcessed -= disburseInfo.partialAmountProcessed;
                    disburseInfo.partialShareProcessed = 0;
                    disburseInfo.partialAmountProcessed = 0;
                }

                burnableShare += amountProcessed;
                withdrableAmount += shareProcessed;
                disburseInfo.requestsIndex += 1;
            } else if (request.epochId == lastEpochId) {
                // partially processed
                EpochInfo memory epoch = epochMap[request.epochId];
                if (epoch.totalShareProcessed > 0) {
                    uint256 shareProcessed = (request.shareRequested * epoch.totalShareProcessed) /
                        epoch.totalShareRequested;
                    uint256 amountProcessed = (request.shareRequested *
                        epoch.totalAmountProcessed) / epoch.totalShareRequested;
                    burnableShare += shareProcessed - disburseInfo.partialShareProcessed;
                    withdrableAmount += amountProcessed - disburseInfo.partialAmountProcessed;
                    disburseInfo.partialShareProcessed = uint96(shareProcessed);
                    disburseInfo.partialAmountProcessed = uint96(amountProcessed);
                }
                break;
            }
        }
    }
}
