// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IDealPortfolioPool} from "./interfaces/IDealPortfolioPool.sol";
import {ITrancheVault, EpochInfo} from "./interfaces/ITrancheVault.sol";

struct UserEpochInfo {
    uint64 epochIndex; // the max index of processed epoch array which was already consumed
    uint96 redeemAmount; // the requested redeem share
    uint64 lastProcessedEpochIndex; // the index of the last processed epoch for this user
}

contract TrancheVault is ERC20, ITrancheVault {
    IDealPortfolioPool public pool;
    uint256 public index; // senior index or junior index

    EpochInfo[] public epochs; // the epoch info array
    uint256 public currentEpochIndex; // the index of the last fully processed epoch

    mapping(address => UserEpochInfo[]) public userEpochs;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /**
     * @notice Returns all unprocessed epochs.
     */
    function unprocessedEpochInfos() external view override returns (EpochInfo[] memory result) {
        uint256 len = epochs.length - currentEpochIndex;
        result = new EpochInfo[](len);
        for (uint256 i; i < len; i++) {
            result[i] = epochs[currentEpochIndex + i];
        }
    }

    function totalSupply() public view override(ERC20, ITrancheVault) returns (uint256) {
        return ERC20.totalSupply();
    }

    /**
     * @notice Updates processed epochs
     */
    function closeEpoch(EpochInfo[] memory processedEpochs) external {
        // update epochs array
        // update currentEpochIndex
        // burn/lock vault tokens
        // withdraw underlying tokens from reserve
    }
}
