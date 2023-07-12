// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPool} from "./interfaces/IPool.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {ITrancheVault, EpochInfo} from "./interfaces/ITrancheVault.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";

interface IEpochManagerLike {
    function currentEpochId() external view returns (uint256);
}

struct UserRedemptionRequest {
    uint64 epochId; // the epochId of EpochInfo
    uint96 shareRequested; // the requested shares to redeem
}

struct UserDisburseInfo {
    // an index of user redemption requests array, withdrawable amounts should be calculated from this request
    uint64 requestsIndex;
    uint96 partialShareProcessed;
    uint96 partialAmountProcessed;
}

contract TrancheVault is ERC20, ITrancheVault {
    uint256 public constant SENIOR_TRANCHE_INDEX = 0;
    uint256 public constant JUNIOR_TRANCHE_INDEX = 1;
    uint256 public constant RATIO_DECIMALS = 10000;

    IEpochManagerLike public epochManager;
    IPool public pool;
    IPoolVault public poolVault;
    PoolConfig public poolConfig;

    uint256 public trancheIndex; // senior index or junior index

    uint256[] public epochIds; // the epoch id array,
    mapping(uint256 => EpochInfo) public epochMapping; // key is epochId
    uint256 public currentEpochIdsIndex; // the index of the epoch id currently being processed

    mapping(address => UserRedemptionRequest[]) public userRedemptionRequests; // user redemption request array
    mapping(address => UserDisburseInfo) public userDisburseInfos;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /**
     * @notice Returns all unprocessed epochs.
     */
    function unprocessedEpochInfos() external view override returns (EpochInfo[] memory result) {
        uint256 len = epochIds.length - currentEpochIdsIndex;
        result = new EpochInfo[](len);
        for (uint256 i; i < len; i++) {
            result[i] = epochMapping[epochIds[currentEpochIdsIndex + i]];
        }
    }

    function totalSupply() public view override(ERC20, ITrancheVault) returns (uint256) {
        return ERC20.totalSupply();
    }

    /**
     * @notice Updates processed epochs
     */
    function closeEpoch(
        EpochInfo[] memory epochsProcessed,
        uint256 sharesProcessed,
        uint256 amountProcessed
    ) external {
        uint256 count = epochsProcessed.length;
        EpochInfo memory epoch;
        for (uint256 i; i < count; i++) {
            epoch = epochsProcessed[i];
            epochMapping[epoch.epochId] = epoch;
        }

        if (epoch.totalAmountProcessed >= epoch.totalShareRequested) {
            currentEpochIdsIndex += count;
        } else if (count - 1 > 0) {
            currentEpochIdsIndex += count - 1;
        }

        ERC20._burn(address(this), sharesProcessed);

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
                ((totalAssets + assets) / tranches[JUNIOR_TRANCHE_INDEX]) * RATIO_DECIMALS >
                maxRatio
            ) revert(); // greater than max ratio
        }

        poolVault.deposit(msg.sender, assets);

        shares = _convertToShares(assets, totalAssets);
        ERC20._mint(receiver, shares);

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
        uint256 userShares = ERC20.balanceOf(msg.sender);
        if (shares < userShares) {
            revert(); // assets is too big
        }

        // update global epochId array and EpochInfo mapping
        uint256 epochId = epochManager.currentEpochId();
        EpochInfo memory epochInfo = epochMapping[epochId];
        if (epochInfo.totalShareRequested > 0) {
            epochInfo.totalShareRequested += uint96(shares);
        } else {
            epochIds.push(epochId);
            epochInfo.epochId = uint64(epochId);
            epochInfo.totalShareRequested = uint96(shares);
        }
        epochMapping[epochId] = epochInfo;

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

        ERC20._transfer(msg.sender, address(this), shares);

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

        EpochInfo memory epochInfo = epochMapping[epochId];
        epochInfo.totalShareRequested -= uint96(shares);
        if (epochInfo.totalShareRequested > 0) {
            epochMapping[epochId] = epochInfo;
        } else {
            delete epochMapping[epochId];
            lastIndex = epochIds.length - 1;
            assert(epochIds[lastIndex] == epochId);
            delete epochIds[lastIndex];
        }

        ERC20._transfer(address(this), msg.sender, shares);

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
        uint256 supply = ERC20.totalSupply();

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
            ERC20._burn(address(this), burnableShare);
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
                EpochInfo memory epoch = epochMapping[request.epochId];
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
                EpochInfo memory epoch = epochMapping[request.epochId];
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
