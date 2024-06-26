// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {HumaConfig} from "../common/HumaConfig.sol";
import {CreditRecord, DueDetail} from "./CreditStructs.sol";
import {ICreditDueManager} from "./interfaces/ICreditDueManager.sol";
import {ICreditManager} from "./interfaces/ICreditManager.sol";
import {IPoolSafe} from "../liquidity/interfaces/IPoolSafe.sol";
import {IFirstLossCover} from "../liquidity/interfaces/IFirstLossCover.sol";
import {IPool} from "../liquidity/interfaces/IPool.sol";

contract CreditStorage {
    HumaConfig public humaConfig;

    // Reference to the due manager contract
    ICreditDueManager public dueManager;
    IPool public pool;
    IPoolSafe public poolSafe;
    IFirstLossCover public firstLossCover;
    ICreditManager public creditManager;

    /// Mapping from credit ID to the CreditRecord.
    mapping(bytes32 => CreditRecord) internal _creditRecordMap;
    /// Mapping from credit ID to the DueDetail.
    mapping(bytes32 => DueDetail) internal _dueDetailMap;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
